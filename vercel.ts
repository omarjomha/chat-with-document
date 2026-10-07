import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  framework: "nextjs",
  crons: [
    {
      // Backstop sweep of lapsed document sessions. Hobby plans allow at most
      // one run per day with roughly an hour of scheduling jitter, which is
      // why cleanup does not depend on this job -- see the route's comment.
      path: "/api/cron/cleanup-sessions",
      schedule: "0 4 * * *",
    },
  ],
};

export default config;
