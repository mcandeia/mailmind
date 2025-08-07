// deno-lint-ignore-file no-explicit-any require-await
import { withRuntime } from "@deco/workers-runtime";
import {
  createStepFromTool,
  createTool,
  createWorkflow,
} from "@deco/workers-runtime/mastra";
import { z } from "zod";
import { type Env, StateSchema, Scopes } from "./deco.gen.ts";

const createGetRecentEmailsTool = (env: Env) =>
  createTool({
    id: "GET_RECENT_EMAILS",
    description: "Get emails from a specified timeframe",
    inputSchema: z.object({
      maxResults: z.number().optional().default(50),
      userId: z.string().optional().default("me"),
      timeframe: z.number().optional().default(1),
      timeframeUnit: z.enum(["minutes", "hours", "days"]).optional().default(
        "days",
      ),
      recipientEmail: z.string().email(),
    }),
    outputSchema: z.object({
      emails: z.array(z.any()),
      resultCount: z.number(),
      maxResults: z.number(),
      userId: z.string(),
      timeframe: z.number(),
      timeframeUnit: z.string(),
      recipientEmail: z.string(),
    }),
    execute: async ({ context }: { context: any }) => {
      // Calculate the timestamp for the timeframe
      const now = new Date();
      let cutoffTime: Date;

      switch (context.timeframeUnit) {
        case "minutes":
          cutoffTime = new Date(
            now.getTime() - (context.timeframe * 60 * 1000),
          );
          break;
        case "hours":
          cutoffTime = new Date(
            now.getTime() - (context.timeframe * 60 * 60 * 1000),
          );
          break;
        case "days":
          cutoffTime = new Date(
            now.getTime() - (context.timeframe * 24 * 60 * 60 * 1000),
          );
          break;
        default:
          cutoffTime = new Date(now.getTime() - (24 * 60 * 60 * 1000)); // Default to 1 day
      }

      // Format date for Gmail API (YYYY/MM/DD format)
      const year = cutoffTime.getFullYear();
      const month = String(cutoffTime.getMonth() + 1).padStart(2, "0");
      const day = String(cutoffTime.getDate()).padStart(2, "0");
      const afterDate = `${year}/${month}/${day}`;

      // Use Gmail's 'after' parameter for more reliable filtering
      const query = `after:${afterDate}`;

      console.log(
        `Searching emails with query: "${query}" (cutoff: ${cutoffTime.toISOString()})`,
      );

      const result = await env.GMAIL.GetEmails({
        userId: context.userId,
        query: query,
        maxResults: context.maxResults,
        includeSpamTrash: false,
      });

      // Additional client-side filtering to ensure accuracy
      const allEmails = result.messages || [];
      const cutoffTimestamp = cutoffTime.getTime();

      const filteredEmails = allEmails.filter((email: any) => {
        if (!email.internalDate && !email.date) return true; // Include if no date info

        const emailTimestamp = email.internalDate
          ? parseInt(email.internalDate)
          : new Date(email.date).getTime();

        return emailTimestamp >= cutoffTimestamp;
      });

      console.log(
        `Found ${allEmails.length} emails from Gmail API, ${filteredEmails.length} after client-side filtering`,
      );

      return {
        emails: filteredEmails,
        resultCount: filteredEmails.length,
        maxResults: context.maxResults,
        userId: context.userId,
        timeframe: context.timeframe,
        timeframeUnit: context.timeframeUnit,
        recipientEmail: context.recipientEmail,
      };
    },
  });

const createProcessEmailsTool = (env: Env) =>
  createTool({
    id: "PROCESS_EMAILS",
    description: "Process emails and generate summary",
    inputSchema: z.object({
      emails: z.array(z.any()),
      resultCount: z.number(),
      maxResults: z.number(),
      userId: z.string(),
      timeframe: z.number(),
      timeframeUnit: z.string(),
      recipientEmail: z.string(),
    }),
    outputSchema: z.object({
      summary: z.string(),
      emailCount: z.number(),
      totalResults: z.number(),
      usage: z.any().optional(),
      recipientEmail: z.string(),
      timeframe: z.number(),
      timeframeUnit: z.string(),
      userId: z.string(),
    }),
    execute: async ({ context }: { context: any }) => {
      const emails = context.emails || [];
      const emailsWithContent = emails.filter((email: any) =>
        email.subject || email.snippet || email.body?.text
      );

      let summary: string;
      let usage: any = null;

      // If no emails found
      if (emailsWithContent.length === 0) {
        summary =
          `No emails found in the last ${context.timeframe} ${context.timeframeUnit}.`;
      } else {
        // Create a text representation of emails for summarization
        const emailsText = emailsWithContent.map((email: any) => {
          const subject = email.subject || "No Subject";
          const from = email.from || "Unknown Sender";
          const snippet = email.snippet || email.body?.text || "No content";
          const date = email.date || email.internalDate || "Unknown date";

          return `Subject: ${subject}
From: ${from}
Date: ${date}
Content: ${snippet}
---`;
        }).join("\n\n");

        // Generate AI summary
        const prompt =
          `Please provide a comprehensive summary of the following ${emailsWithContent.length} emails from the last ${context.timeframe} ${context.timeframeUnit}. 

Group the emails by topic/category and highlight:
- Key action items or requests
- Important updates or announcements  
- Urgent items needing attention
- Overall themes and patterns

Emails data:
${emailsText}

Please structure your response with clear sections and bullet points for easy reading.`;

        const aiResult = await env.DECO_CHAT_WORKSPACE_API.AI_GENERATE({
          messages: [
            {
              role: "user",
              content: prompt,
            },
          ],
          maxTokens: 4000,
          temperature: 0.3,
        });

        summary = aiResult.text || "Failed to generate summary";
        usage = aiResult.usage;
      }

      return {
        summary,
        emailCount: emailsWithContent.length,
        totalResults: context.resultCount,
        usage,
        recipientEmail: context.recipientEmail,
        timeframe: context.timeframe,
        timeframeUnit: context.timeframeUnit,
        userId: context.userId,
      };
    },
  });

const createSendEmailTool = (env: Env) =>
  createTool({
    id: "SEND_EMAIL",
    description: "Send an email with the summary",
    inputSchema: z.object({
      summary: z.string(),
      emailCount: z.number(),
      totalResults: z.number(),
      usage: z.any().optional(),
      recipientEmail: z.string(),
      timeframe: z.number(),
      timeframeUnit: z.string(),
      userId: z.string(),
    }),
    outputSchema: z.object({
      summary: z.string(),
      emailCount: z.number(),
      totalResults: z.number(),
      usage: z.any().optional(),
      emailSent: z.boolean(),
      messageId: z.string(),
    }),
    execute: async ({ context }: { context: any }) => {
      const subject =
        `Email Summary - ${context.emailCount} emails from last ${context.timeframe} ${context.timeframeUnit}`;

      const result = await env.GMAIL.SendEmail({
        userId: context.userId,
        to: context.recipientEmail,
        subject: subject,
        bodyText: context.summary,
        bodyHtml: `<pre>${context.summary}</pre>`,
      });

      return {
        summary: context.summary,
        emailCount: context.emailCount,
        totalResults: context.totalResults,
        usage: context.usage,
        emailSent: true,
        messageId: result.id || "",
      };
    },
  });

const createEmailSummaryWorkflow = (env: Env) => {
  const getEmailsStep = createStepFromTool(createGetRecentEmailsTool(env));
  const processEmailsStep = createStepFromTool(createProcessEmailsTool(env));
  const sendEmailStep = createStepFromTool(createSendEmailTool(env));

  return createWorkflow({
    id: "EMAIL_SUMMARY_WORKFLOW",
    inputSchema: z.object({
      maxResults: z.number().optional().default(50),
      userId: z.string().optional().default("me"),
      timeframe: z.number().optional().default(1),
      timeframeUnit: z.enum(["minutes", "hours", "days"]).optional().default(
        "days",
      ),
      recipientEmail: z.string().email(),
    }),
    outputSchema: z.object({
      summary: z.string(),
      emailCount: z.number(),
      totalResults: z.number(),
      usage: z.any().optional(),
      emailSent: z.boolean(),
    }),
  })
    .then(getEmailsStep)
    .then(processEmailsStep)
    .then(sendEmailStep)
    .map(async ({ inputData }) => {
      return {
        summary: inputData.summary,
        emailCount: inputData.emailCount,
        totalResults: inputData.totalResults,
        usage: inputData.usage,
        emailSent: inputData.emailSent,
      };
    })
    .commit();
};

const { Workflow, ...runtime } = withRuntime<Env, typeof StateSchema>({
  oauth: {
    state: StateSchema,
    scopes: ["AI_GENERATE", Scopes.GMAIL.SendEmail, Scopes.GMAIL.GetEmails],
  },
  workflows: [createEmailSummaryWorkflow],
  tools: [
    createGetRecentEmailsTool,
    createProcessEmailsTool,
    createSendEmailTool,
  ],
});

export { Workflow };

export default runtime;
