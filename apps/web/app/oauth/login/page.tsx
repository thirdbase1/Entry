import { redirect } from 'next/navigation';

/**
 * Legacy OAuth login page — now redirects to sign-in.
 * Better Auth's social sign-on is initiated directly from the sign-in
 * page via authClient.signIn.social().
 */
export default function OAuthLoginPage() {
  redirect('/sign-in');
}
