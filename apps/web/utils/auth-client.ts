import { createAuthClient } from "better-auth/react";
import { env } from "@/env";
import { ssoClient } from "@better-auth/sso/client";
import { organizationClient } from "better-auth/client/plugins";

export const { signIn, signOut, signUp, useSession, getSession, sso } =
  createAuthClient({
    baseURL: env.NEXT_PUBLIC_BASE_URL,
    plugins: [ssoClient(), organizationClient()],
  });

// better-auth >=1.7.7 no longer exports `genericOAuthClient` from
// "better-auth/client/plugins", so the options type is declared here instead
// of being derived from that client. The request itself is unchanged: it still
// posts to the server-side generic-oauth plugin's /sign-in/oauth2 endpoint,
// which is only used by the Google/Microsoft OAuth emulator (dev/test).
// Production Google login uses `signIn.social`.
type SignInWithOauth2Options = {
  providerId: string;
  callbackURL?: string;
  errorCallbackURL?: string;
  newUserCallbackURL?: string;
  disableRedirect?: boolean;
  scopes?: string[];
  requestSignUp?: boolean;
};

export async function signInWithOauth2(options: SignInWithOauth2Options) {
  const response = await fetch("/api/auth/sign-in/oauth2", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(options),
  });

  const payload = await parseOauth2Response(response);
  if (!response.ok) {
    throw new Error(
      payload.error || `Request failed with status ${response.status}`,
    );
  }

  return payload;
}

async function parseOauth2Response(response: Response) {
  try {
    const data = (await response.json()) as {
      url?: string;
      message?: string;
      error?: string;
    };

    return {
      url: data.url,
      error: data.error || data.message,
    };
  } catch {
    return {
      error: `Request failed with status ${response.status}`,
    };
  }
}
