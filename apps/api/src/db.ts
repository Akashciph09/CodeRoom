import { createDb } from "@coderoom/db";
import { config } from "./config.js";

export const { db, close: closeDb } = createDb(config.DATABASE_URL);
