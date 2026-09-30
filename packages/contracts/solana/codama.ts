/**
 * The TypeScript client for the Solana program, generated from its IDL with Codama: instructions, accounts, errors
 * and PDAs, for `@solana/kit`. The relayer, the deploy script and the mobile app use it.
 *
 *   bun run solana:client     (from packages/contracts, after solana:build)
 */
import { rootNodeFromAnchor, type AnchorIdl } from "@codama/nodes-from-anchor";
import { renderVisitor } from "@codama/renderers-js";
import { createFromRoot } from "codama";
import { join } from "node:path";

const idl = (await Bun.file(join(import.meta.dir, "target/idl/skech.json")).json()) as AnchorIdl;
const codama = createFromRoot(rootNodeFromAnchor(idl));
await codama.accept(renderVisitor(import.meta.dir, { generatedFolder: "client", deleteFolderBeforeRendering: true, syncPackageJson: false, kitImportStrategy: "rootOnly" }));
// The IDL goes along with the client: the relayer decodes events with it.
await Bun.write(join(import.meta.dir, "client/idl.json"), JSON.stringify(idl, null, 2) + "\n");
console.log("wrote packages/contracts/solana/client");
