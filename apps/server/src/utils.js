import { customAlphabet } from "nanoid";

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const nanoCode = customAlphabet(alphabet, 6);

const avatars = [
  "bunny-sprout",
  "mochi-cat",
  "tofu-fox",
  "duckling-pilot",
  "panda-boba",
  "shiba-cloud",
  "frog-prince",
  "otter-donut",
  "hamster-hero",
  "koala-kite"
];

export function generateGameCode() {
  return nanoCode();
}

export function randomAvatarSeed() {
  return avatars[Math.floor(Math.random() * avatars.length)];
}

export function normalizeCode(value) {
  return String(value || "").trim().toUpperCase();
}
