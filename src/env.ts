function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name} in .env`);
  return value;
}

export const env = {
  projectId: required("PROJECT_ID"),
  projectSecret: required("PROJECT_SECRET"),
  xaiApiKey: required("XAI_API_KEY"),
  xaiModel: process.env.XAI_MODEL?.trim() || "grok-4.7",
  databaseUrl: required("DATABASE_URL"),
  googleClientId: required("GOOGLE_CLIENT_ID"),
  googleClientSecret: required("GOOGLE_CLIENT_SECRET"),
  publicBaseUrl: required("PUBLIC_BASE_URL").replace(/\/$/, ""),
  timezone: "America/Los_Angeles",
};

export const oauthRedirectUri = `${env.publicBaseUrl}/oauth/callback`;
