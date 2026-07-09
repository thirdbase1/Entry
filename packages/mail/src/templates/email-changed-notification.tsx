import { Content, Name, P, Template, Title } from '../components/template';

export type EmailChangedNotificationProps = { to: string };

export default function EmailChangedNotification(props: EmailChangedNotificationProps) {
  return (
    <Template>
      <Title>Verify your current email for Entry</Title>
      <Content>
        <P>
          As per your request, we have changed your email. Please make sure you&apos;re using <Name>{props.to}</Name>{' '}
          to log in the next time.
        </P>
      </Content>
    </Template>
  );
}
