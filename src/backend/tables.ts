import {
  defineTable,
  id,
  integer,
  json,
  refUser,
  text,
  timestamp,
  varchar,
} from "@termix-ssh/plugin-sdk/db";

// Stored as p_agent_chat_chats. One chat session per row; the agent conversation
// lives in messages.
export const chats = defineTable(
  "chats",
  {
    id: id(),
    userId: refUser(),
    title: varchar(255).notNull(),
    // "ask" | "auto-safe" | "auto"
    approvalMode: varchar(20).notNull().default("ask"),
    createdAt: timestamp().notNull().defaultNow(),
    updatedAt: timestamp().notNull().defaultNow(),
  },
  {
    indexes: [{ name: "idx_p_agent_chat_chats_user_id", columns: ["userId"] }],
  },
);

// One conversation entry per row. `parts` holds role-specific content:
// - user:      { text }
// - assistant: { text, toolCalls: [{ id, hostId, command }], thinking?: string }
// - tool:      { toolCallId, hostId, command, stdout, stderr, exitCode,
//                truncated, timedOut, denied, error }
// `seq` orders entries inside a chat; autoincrement ids are not reliable
// ordering across engines once rows are inserted out of order.
export const messages = defineTable(
  "messages",
  {
    id: id(),
    chatId: integer().notNull(),
    userId: refUser(),
    seq: integer().notNull(),
    role: varchar(20).notNull(),
    parts: json().notNull(),
    createdAt: timestamp().notNull().defaultNow(),
  },
  {
    indexes: [
      {
        name: "idx_p_agent_chat_messages_chat_seq",
        columns: ["chatId", "seq"],
      },
    ],
  },
);

// termix-plugin migrations reads this list.
export const tables = [chats, messages];
