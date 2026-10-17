import fontkit from "@pdf-lib/fontkit";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createProvider } from "../src/lib/fontsCore.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "vendor", "fonts");
export const nodeFonts = createProvider({ fontkit, loadBytes: async (f) => readFileSync(join(dir, f)) });
