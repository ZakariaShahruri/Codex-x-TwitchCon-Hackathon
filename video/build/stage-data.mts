// Writes the stage page's fake values to video/renders/stage-data.js, reusing the Leak Gauntlet's synthetic cases
// (already proven detectable) so nothing real or newly invented ends up on stream. Output is gitignored.
import { mkdir, writeFile } from "node:fs/promises";
import { gauntletCases } from "../../tools/gauntlet/cases.js";

const text = (id: string) => {
  const found = gauntletCases.find((item) => item.id === id);
  if (!found) throw new Error(`No Gauntlet case ${id}`);
  return found.text;
};

const data = {
  apiKey: text("sk-project"),
  password: text("password-env"),
  email: text("email"),
  address: text("watchlist-address"),
  orderDecoy: text("decoy-order-id"),
  card: text("card-visa"),
  cardDecoy: text("decoy-non-luhn-card"),
  seed: text("seed-labeled"),
  ip: text("ip-v4"),
  ipDecoy: text("decoy-public-dns"),
  versionDecoy: text("decoy-react-version"),
};

await mkdir(new URL("../renders/", import.meta.url), { recursive: true });
await writeFile(new URL("../renders/stage-data.js", import.meta.url), `window.STAGE = ${JSON.stringify(data, null, 2)};\n`);
console.log("wrote video/renders/stage-data.js");
