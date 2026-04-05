import { z } from "zod";

/**
 * CLI environment config.
 *
 * Read once at startup. Overridable via env vars so users can point
 * at a self-hosted broker or a staging instance without rebuilding.
 */
const envSchema = z.object({
  CLAUDEMESH_BROKER_URL: z.string().default("wss://ic.claudemesh.com/ws"),
  CLAUDEMESH_CONFIG_DIR: z.string().optional(),
  CLAUDEMESH_DEBUG: z.coerce.boolean().default(false),
});

export type CliEnv = z.infer<typeof envSchema>;

export function loadEnv(): CliEnv {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("[claudemesh] invalid environment:");
    console.error(z.treeifyError(parsed.error));
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();
