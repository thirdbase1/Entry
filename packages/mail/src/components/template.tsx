import {
  Body,
  Button as EmailButton,
  Container,
  Head,
  Html,
  Img,
  Link,
  Row,
  Section,
  Text as EmailText,
} from 'react-email';
import type { PropsWithChildren, ReactElement, ReactNode } from 'react';

import { BasicTextStyle } from './common';
import { Footer } from './footer';

/**
 * Ported verbatim from mails/components/template.tsx — the original's
 * hand-rolled `<Title>`/`<Content>`/`<Button>` mini-DSL that every user
 * mail template composes with. Kept identical (down to the runtime
 * assertions) rather than "simplified," since 1:1 output parity across
 * every mail is the whole point of this port.
 */

export function Title(props: PropsWithChildren) {
  return (
    <EmailText
      style={{
        ...BasicTextStyle,
        fontSize: '20px',
        fontWeight: '600',
        lineHeight: '28px',
      }}
    >
      {props.children}
    </EmailText>
  );
}

export function P(props: PropsWithChildren) {
  return <EmailText style={BasicTextStyle}>{props.children}</EmailText>;
}

export function Text(props: PropsWithChildren) {
  return <span style={BasicTextStyle}>{props.children}</span>;
}

export function SecondaryText(props: PropsWithChildren) {
  return (
    <span
      style={{
        ...BasicTextStyle,
        color: '#7A7A7A',
        fontSize: '14px',
        lineHeight: '22px',
      }}
    >
      {props.children}
    </span>
  );
}

export function Bold(props: PropsWithChildren) {
  return <span style={{ fontWeight: 600 }}>{props.children}</span>;
}

export const Avatar = (props: { img: string; width?: string; height?: string }) => {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={props.img}
      alt="avatar"
      style={{
        width: props.width || '20px',
        height: props.height || '20px',
        borderRadius: '12px',
        objectFit: 'cover',
        verticalAlign: 'middle',
      }}
    />
  );
};

export const OnelineCodeBlock = (props: PropsWithChildren) => {
  return (
    <pre
      style={{
        ...BasicTextStyle,
        whiteSpace: 'nowrap',
        border: '1px solid rgba(0,0,0,.1)',
        padding: '8px 10px',
        borderRadius: '4px',
        backgroundColor: '#F5F5F5',
      }}
    >
      {props.children}
    </pre>
  );
};

export const Name = (props: PropsWithChildren) => {
  return <Bold>{props.children}</Bold>;
};

export const AvatarWithName = (props: { img?: string; name: string; width?: string; height?: string }) => {
  return (
    <>
      {props.img && <Avatar img={props.img} width={props.width} height={props.height} />}
      <Name>{props.name}</Name>
    </>
  );
};

export function Content(props: PropsWithChildren) {
  return typeof props.children === 'string' ? <EmailText>{props.children}</EmailText> : <>{props.children}</>;
}

export function Button(props: PropsWithChildren<{ type?: 'primary' | 'secondary'; href: string }>) {
  const style = {
    ...BasicTextStyle,
    backgroundColor: props.type === 'secondary' ? '#FFFFFF' : '#1E96EB',
    color: props.type === 'secondary' ? '#141414' : '#FFFFFF',
    textDecoration: 'none',
    fontWeight: '600',
    padding: '8px 18px',
    borderRadius: '8px',
    border: '1px solid rgba(0,0,0,.1)',
    marginRight: '4px',
  };

  return (
    <EmailButton style={style} href={props.href}>
      {props.children}
    </EmailButton>
  );
}

function fetchTitle(children: ReactElement<PropsWithChildren>[]): ReactElement {
  const title = children.find(child => child.type === Title);
  if (!title || !title.props.children) {
    throw new Error('<Title /> is required for an email.');
  }
  return title;
}

function fetchContent(children: ReactElement<PropsWithChildren>[]): ReactElement | ReactElement[] {
  const content = children.find(child => child.type === Content);
  if (!content || !content.props.children) {
    throw new Error('<Content /> is required for an email.');
  }
  if (Array.isArray(content.props.children)) {
    return content.props.children.map((child, i) => <Row key={i}>{child}</Row>);
  }
  return content;
}

function assertChildrenIsArray(children: ReactNode): asserts children is ReactElement<PropsWithChildren>[] {
  if (!Array.isArray(children) || !children.every(child => typeof child === 'object' && child !== null && 'type' in child)) {
    throw new Error('Children of `Template` element must be an array of [<Title />, <Content />, ...]');
  }
}

/**
 * One behavioral difference from the original, deliberate and documented:
 * the original short-circuits to bare `content` when `globalThis.env.testing`
 * (a NestJS-app-wide test flag) is set, to make snapshot tests smaller. This
 * package has no equivalent global test flag (that concept doesn't exist
 * outside the old NestJS app bootstrap) — always renders the full `<Html>`
 * wrapper. Doesn't affect production output at all; only affects unit-test
 * snapshot verbosity if/when tests for this package are written.
 */
export function Template(props: PropsWithChildren) {
  assertChildrenIsArray(props.children);

  const content = (
    <>
      <Section>{fetchTitle(props.children)}</Section>
      <Section>{fetchContent(props.children)}</Section>
    </>
  );

  return (
    <Html>
      <Head />
      <Body style={{ backgroundColor: '#f6f7fb', overflow: 'hidden' }}>
        <Container
          style={{
            backgroundColor: '#fff',
            maxWidth: '450px',
            margin: '32px auto 0',
            borderRadius: '16px 16px 0 0',
            boxShadow: '0px 0px 20px 0px rgba(66, 65, 73, 0.04)',
            padding: '24px',
          }}
        >
          <Section>
            <Link href="https://entry.io">
              <Img src="https://entry.io/assets/icons/logo.svg" alt="Entry logo" height="32px" />
            </Link>
          </Section>
          {content}
        </Container>
        <Footer />
      </Body>
    </Html>
  );
}
