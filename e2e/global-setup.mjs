import { writeFixtures } from "./fixtures/make.mjs";

export default async function globalSetup() {
  await writeFixtures();
}
