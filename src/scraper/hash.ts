import { createHash } from "node:crypto"

/** Lower-case hex SHA-256 digest of `bytes`. */
export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")
