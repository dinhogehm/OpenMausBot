// Compatibility alias: `openmausbot pair` lives in cli.ts now. Kept because
// docs and images reference dist-server/pair-cli.js.
import { main } from "./cli.ts";

main(["pair", ...process.argv.slice(2)]).then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
