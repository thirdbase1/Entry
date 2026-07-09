/**
 * Replaces core/mail/{mailer,sender,job,config,resolver}.ts + mails/index.tsx's
 * Renderers map, collapsed into one package.
 *
 * Transport: **SendByte** (docs.sendbyte.africa), swapped in at the user's
 * explicit request in place of the earlier Resend wiring. SendByte's REST
 * API/SDK takes raw `html` (not a React element like Resend's `{ react }`
 * param), so this package now renders each `react-email`
 * template to an HTML string itself via `react-email` — the
 * templates in ./templates and ./components are untouched, only the last
 * mile (render -> send) changed. This keeps the templates provider-agnostic,
 * which is good practice regardless of which transactional email API sits
 * behind it.
 *
 * `MailName` keys and per-mail subjects are kept 1:1 with the original's
 * `Renderers` map in mails/index.tsx.
 */
import { render } from 'react-email';
import { SendByte } from '@sendbyte/node';

import ChangeEmail from './templates/change-email';
import ChangePassword from './templates/change-password';
import EmailChangedNotification from './templates/email-changed-notification';
import SetPassword from './templates/set-password';
import SignIn from './templates/sign-in';
import SignUp from './templates/sign-up';
import VerifyChangeEmail from './templates/verify-change-email';
import VerifyEmail from './templates/verify-email';

export type MailName =
  | 'SignIn'
  | 'SignUp'
  | 'SetPassword'
  | 'ChangePassword'
  | 'VerifyEmail'
  | 'ChangeEmail'
  | 'VerifyChangeEmail'
  | 'EmailChanged';

type MailPropsMap = {
  SignIn: { url: string; otp: string };
  SignUp: { url: string; otp: string };
  SetPassword: { url: string };
  ChangePassword: { url: string };
  VerifyEmail: { url: string };
  ChangeEmail: { url: string };
  VerifyChangeEmail: { url: string };
  EmailChanged: { to: string };
};

/** Subjects ported verbatim from mails/index.tsx's `Renderers` map. */
const MAIL_REGISTRY: {
  [K in MailName]: { subject: string; Component: (props: MailPropsMap[K]) => React.ReactElement };
} = {
  SignIn: { subject: 'Sign in to Entry', Component: SignIn },
  SignUp: { subject: 'Your Entry account is waiting for you!', Component: SignUp },
  SetPassword: { subject: 'Set your Entry password', Component: SetPassword },
  ChangePassword: { subject: 'Modify your Entry password', Component: ChangePassword },
  VerifyEmail: { subject: 'Verify your email address', Component: VerifyEmail },
  ChangeEmail: { subject: 'Change your email address', Component: ChangeEmail },
  VerifyChangeEmail: { subject: 'Verify your new email address', Component: VerifyChangeEmail },
  EmailChanged: { subject: 'Account email address changed', Component: EmailChangedNotification },
};

export interface SendMailInput<T extends MailName = MailName> {
  name: T;
  to: string;
  props: MailPropsMap[T];
}

let sendbyteClient: SendByte | null | undefined;

/** Lazy client — mirrors packages/db's lazy-Proxy pattern so importing this package doesn't throw at module-eval/build time when SENDBYTE_API_KEY isn't set (e.g. `next build` collecting page data). */
function getSendByte(): SendByte | null {
  if (sendbyteClient !== undefined) return sendbyteClient;
  const key = process.env.SENDBYTE_API_KEY;
  sendbyteClient = key ? new SendByte(key) : null;
  return sendbyteClient;
}

// e.g. "Entry <noreply@yourdomain.com>" — must be a verified SendByte sending
// domain in live mode, or any address when using a sk_test_ sandbox key.
const FROM = process.env.SENDBYTE_FROM_DOMAIN ?? 'Entry <noreply@entry.io>';

/**
 * `trySend` equivalent from the original's `Mailer.trySend` — never throws,
 * returns false on any failure (missing config, provider rejection, etc.)
 * so auth flows can call this without wrapping every call site in try/catch.
 */
export async function sendMail<T extends MailName>({ name, to, props }: SendMailInput<T>): Promise<boolean> {
  const sendbyte = getSendByte();
  const { subject, Component } = MAIL_REGISTRY[name];

  if (!sendbyte) {
    // Same "not configured" fallback the original had (`EmailServiceNotConfigured`
    // when suppressError=false) — except here we always log-and-continue rather
    // than throw, since sendMail's only caller (AuthService) already treats a
    // `false` return as "don't block the request, just note it didn't send."
    console.warn(`[mail] SENDBYTE_API_KEY not set — would have sent "${name}" to ${to} (subject: "${subject}")`);
    return false;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const html = await render(Component(props as any));

    const result = await sendbyte.emails.send({
      from: FROM,
      to,
      subject,
      html,
    });

    if (!result?.id) {
      console.error(`[mail] SendByte returned no id for "${name}" to ${to}:`, result);
      return false;
    }

    return true;
  } catch (err) {
    console.error(`[mail] Failed to send "${name}" to ${to}:`, err);
    return false;
  }
}
