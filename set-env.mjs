import { execSync } from "child_process";

const envs = {
  DATABASE_URL: "postgresql://neondb_owner:npg_Ad0qYBR1TIex@ep-flat-math-aianhc8l-pooler.c-4.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
  JWT_SECRET: "dev-change-this-secret-before-production",
  VITE_API_URL: "/api"
};

for (const [key, value] of Object.entries(envs)) {
  console.log(`Setting ${key}...`);
  try {
    execSync(`npx vercel env rm ${key} production -y`, { stdio: 'ignore' });
  } catch (e) {} // ignore if it doesn't exist
  execSync(`npx vercel env add ${key} production`, { input: value, stdio: 'pipe' });
}
console.log("Done setting environment variables.");
