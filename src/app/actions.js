const axios = require("axios");
const config = require("../config");

// Helper: search for a user in JIRA by name or email.
async function getUserFromName(query) {
  try {
    const response = await axios.get(
      `${config.jira.baseUrl}/rest/api/3/user/search?query=${encodeURIComponent(
        query
      )}`,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${Buffer.from(
            `${config.jira.adminEmail}:${config.jira.apiToken}`
          ).toString("base64")}`,
        },
      }
    );
    return response.data && response.data.length > 0 ? response.data[0] : null;
  } catch (error) {
    console.error("Error searching user in JIRA:", error);
    return null;
  }
}

// Helper: search for issues by title using a JQL query.
// Returns an array of matching issues.
async function getIssuesByTitle(title) {
  const jql = `project = "${config.jira.projectKey}" AND summary ~ "${title}"`;
  try {
    const response = await axios.get(
      `${config.jira.baseUrl}/rest/api/3/search?jql=${encodeURIComponent(jql)}`,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${Buffer.from(
            `${config.jira.adminEmail}:${config.jira.apiToken}`
          ).toString("base64")}`,
        },
      }
    );
    return response.data && response.data.issues ? response.data.issues : [];
  } catch (error) {
    console.error("Error fetching issues from JIRA:", error);
    return [];
  }
}

// Create Task: Checks for duplicate tasks unless forceCreate is true.
async function createTask(context, state, parameters) {
  const { title, description, assignees, forceCreate } = parameters;

  const existingIssues = await getIssuesByTitle(title);
  if (existingIssues.length > 0 && !forceCreate) {
    const existingKeys = existingIssues.map((issue) => issue.key).join(", ");
    return `**Task with title '${title}' already exists in JIRA with key(s): ${existingKeys}.**`;
  }

  const primaryAssigneeName = assignees[0] || config.jira.adminEmail;
  let user = await getUserFromName(primaryAssigneeName);
  let primaryAssigneeAccountId;
  if (user && user.accountId) {
    primaryAssigneeAccountId = user.accountId;
  } else {
    let adminUser = await getUserFromName(config.jira.adminEmail);
    primaryAssigneeAccountId =
      adminUser && adminUser.accountId ? adminUser.accountId : undefined;
  }

  const data = {
    fields: {
      project: { key: config.jira.projectKey },
      summary: title,
      description: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [
              {
                text: description,
                type: "text",
              },
            ],
          },
        ],
      },
      issuetype: { name: "Task" },
    },
  };

  if (primaryAssigneeAccountId) {
    data.fields.assignee = { accountId: primaryAssigneeAccountId };
  }

  try {
    const response = await axios.post(
      `${config.jira.baseUrl}/rest/api/3/issue`,
      data,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${Buffer.from(
            `${config.jira.adminEmail}:${config.jira.apiToken}`
          ).toString("base64")}`,
        },
      }
    );

    if (!state.conversation.tasks) {
      state.conversation.tasks = {};
    }
    state.conversation.tasks[title] = {
      title,
      description,
      assignees,
      jiraIssueKey: response.data.key,
      jiraUrl: `${config.jira.baseUrl}/browse/${response.data.key}`,
    };

    return `**Task created in JIRA with key ${response.data.key}.**`;
  } catch (error) {
    console.error("Error creating JIRA task:", error);
    await context.sendActivity(
      `**Error creating task in JIRA: ${error.message}**`
    );
    return "**Failed to create task in JIRA.**";
  }
}

// Update Task: Uses fuzzy matching; if multiple issues are found, returns a list for clarification.
async function updateTask(context, state, parameters) {
  const { title, status } = parameters;
  const issues = await getIssuesByTitle(title);

  if (issues.length === 0) {
    return `**No issue found in JIRA matching '${title}'.**`;
  }
  if (issues.length > 1) {
    let message = `**Multiple issues found matching '${title}':**\n`;
    issues.forEach((issue) => {
      message += `- **${issue.key}**: ${issue.fields.summary}\n`;
    });
    message +=
      "\n**Please provide a more specific title or the issue key to update.**";
    return message;
  }

  const issueKey = issues[0].key;
  const statusTransitionMapping = { inProgress: "31", done: "41" };
  const transitionId = statusTransitionMapping[status];
  if (!transitionId) {
    await context.sendActivity(`**Invalid status '${status}'.**`);
    return `**Invalid status '${status}'.**`;
  }

  try {
    await axios.post(
      `${config.jira.baseUrl}/rest/api/3/issue/${issueKey}/transitions`,
      { transition: { id: transitionId } },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${Buffer.from(
            `${config.jira.adminEmail}:${config.jira.apiToken}`
          ).toString("base64")}`,
        },
      }
    );
    await context.sendActivity(`**Task '${title}' updated to '${status}'.**`);
    return `**Task '${title}' updated to '${status}'.**`;
  } catch (error) {
    console.error("Error updating JIRA task:", error);
    await context.sendActivity(
      `**Error updating task '${title}': ${error.message}**`
    );
    return `**Failed to update task '${title}'.**`;
  }
}

// Delete Task: If multiple matches are found, returns a list for clarification.
async function deleteTask(context, state, parameters) {
  const { title } = parameters;
  const issues = await getIssuesByTitle(title);

  if (issues.length === 0) {
    await context.sendActivity(
      `**No issue found in JIRA matching '${title}'.**`
    );
    return `**No issue found in JIRA matching '${title}'.**`;
  }
  if (issues.length > 1) {
    let message = `**Multiple issues found matching '${title}':**\n`;
    issues.forEach((issue) => {
      message += `- **${issue.key}**: ${issue.fields.summary}\n`;
    });
    await context.sendActivity(message);
    await context.sendActivity(
      "**Please provide a more specific title or the issue key to delete.**"
    );
    return message;
  }

  const issueKey = issues[0].key;
  try {
    await axios.delete(`${config.jira.baseUrl}/rest/api/3/issue/${issueKey}`, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(
          `${config.jira.adminEmail}:${config.jira.apiToken}`
        ).toString("base64")}`,
      },
    });

    if (state.conversation.tasks && state.conversation.tasks[title]) {
      delete state.conversation.tasks[title];
    }

    await context.sendActivity(`**Task '${title}' deleted from JIRA.**`);
    return `**Task '${title}' deleted from JIRA.**`;
  } catch (error) {
    console.error("Error deleting JIRA task:", error);
    await context.sendActivity(
      `**Error deleting task '${title}': ${error.message}**`
    );
    return `**Failed to delete task '${title}'.**`;
  }
}

// Query Task: Returns well-structured details for matching issues using Markdown formatting.
async function queryTask(context, state, parameters) {
  const { title } = parameters;
  const issues = await getIssuesByTitle(title);

  if (issues?.length === 0) {
    return `**No issue found in JIRA matching '${title}'.**`;
  } else {
    let message = `**There are ${issues?.length} issues related to '${title}':**\n\n`;
    issues.forEach((issue, index) => {
      const key = issue.key;
      const summary = issue.fields.summary || "No summary";
      const status = issue.fields.status ? issue.fields.status.name : "Unknown";

      let descriptionText = "";
      if (typeof issue.fields.description === "string") {
        descriptionText = issue.fields.description;
      } else if (issue.fields.description && issue.fields.description.content) {
        descriptionText = issue.fields.description.content
          .map((paragraph) => {
            if (paragraph.content) {
              return paragraph.content.map((piece) => piece.text).join(" ");
            }
            return "";
          })
          .join("\n");
      } else {
        descriptionText = "No description provided.";
      }

      const assignee = issue.fields.assignee
        ? issue.fields.assignee.displayName
        : "Unassigned";
      const created = issue.fields.created
        ? new Date(issue.fields.created).toLocaleString()
        : "Unknown";

      message += `${index + 1}. **${summary} (${key})**\n`;
      message += `   - **Status:** ${status}\n`;
      message += `   - **Description:** ${descriptionText}\n`;
      message += `   - **Assignee:** ${assignee}\n`;
      message += `   - **Created:** ${created}\n\n`;
    });
    return message;
  }
}

// List Tasks: Dynamically filter by statuses, assignee, and supports pagination.
async function listTasks(context, state, parameters) {
  if (!context || typeof context.sendActivity !== "function") {
    throw new Error("Invalid context provided to listTasks");
  }

  parameters = parameters || {};
  let statuses = parameters.statuses;
  let startAt = parseInt(parameters.startAt || 0, 10);
  const maxResults = 10;

  let statusCondition = "";
  if (statuses) {
    statuses = Array.isArray(statuses) ? statuses : [statuses];
    if (statuses.length > 0) {
      const statusesList = statuses.map((s) => `"${s}"`).join(", ");
      statusCondition = ` AND status in (${statusesList})`;
    }
  }
  if (!statusCondition) {
    statusCondition = ` AND status in ("To Do", "In Progress")`;
  }

  let assigneeFilter = "";
  if (parameters.assignee) {
    const user = await getUserFromName(parameters.assignee);
    if (user?.accountId) {
      assigneeFilter = ` AND assignee = "${user.accountId}"`;
    } else {
      return `**No user found matching '${parameters.assignee}'.**`;
    }
  }

  let priorityFilter = "";
  if (parameters.priorities) {
    let priorities = Array.isArray(parameters.priorities)
      ? parameters.priorities
      : [parameters.priorities];
    if (priorities.length > 0) {
      const prioritiesList = priorities.map((p) => `"${p}"`).join(", ");
      priorityFilter = ` AND priority in (${prioritiesList})`;
    }
  }

  const jql = `project = "${config.jira.projectKey}" AND issuetype = "Task"${statusCondition}${assigneeFilter}${priorityFilter}`;

  try {
    const response = await axios.get(
      `${config.jira.baseUrl}/rest/api/3/search?jql=${encodeURIComponent(
        jql
      )}&maxResults=${maxResults}&startAt=${startAt}`,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${Buffer.from(
            `${config.jira.adminEmail}:${config.jira.apiToken}`
          ).toString("base64")}`,
        },
      }
    );

    const issues = Array.isArray(response?.data?.issues)
      ? response.data.issues
      : [];
    const total =
      typeof response?.data?.total === "number" ? response.data.total : 0;

    if (issues.length === 0) {
      return "**No tasks found matching the specified criteria.**";
    }

    let message = `**Found ${total} task(s) matching your criteria.**\n\n`;
    message += `**Showing tasks ${startAt + 1} to ${
      startAt + issues.length
    }:**\n\n`;

    for (const issue of issues) {
      if (!issue) continue;

      const fields = issue.fields || {};
      const key = issue.key || "Unknown";
      const summary = fields.summary || "No summary";
      const status = fields.status?.name || "Unknown";
      const priority = fields.priority?.name || "Not Specified";
      const assignee = fields.assignee?.displayName || "Unassigned";
      const reporter = fields.reporter?.displayName || "Unknown";
      const created = fields.created
        ? new Date(fields.created).toLocaleString()
        : "Unknown";

      message += `**Issue Key   :** ${key}\n\n`;
      message += `**Summary     :** ${summary}\n\n`;
      message += `**Status      :** ${status}\n\n`;
      message += `**Priority    :** ${priority}\n\n`;
      message += `**Assignee    :** ${assignee}\n\n`;
      message += `**Reporter    :** ${reporter}\n\n`;
      message += `**Created     :** ${created}\n\n --- \n\n`;
    }

    // await context.sendActivity(message);
    return message;
  } catch (error) {
    console.error("Error listing tasks from JIRA:", error);
    return `**Error listing tasks: ${error.message}**`;
  }
}

module.exports = {
  createTask,
  updateTask,
  deleteTask,
  queryTask,
  listTasks,
};
