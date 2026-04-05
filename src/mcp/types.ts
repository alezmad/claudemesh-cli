/**
 * MCP tool schemas + shared types for the CLI's MCP server.
 */

export type Priority = "now" | "next" | "low";
export type PeerStatus = "idle" | "working" | "dnd";

export interface SendMessageArgs {
  to: string; // peer name, pubkey, or #channel
  message: string;
  priority?: Priority;
}

export interface ListPeersArgs {
  mesh_slug?: string; // filter to one joined mesh
}

export interface SetSummaryArgs {
  summary: string;
}

export interface SetStatusArgs {
  status: PeerStatus;
}
