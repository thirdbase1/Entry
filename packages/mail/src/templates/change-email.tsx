import { Bold, Button, Content, P, Template, Title } from '../components/template';

export type ChangeEmailProps = { url: string };

export default function ChangeEmail(props: ChangeEmailProps) {
  return (
    <Template>
      <Title>Verify your current email for Entry</Title>
      <Content>
        <P>
          You recently requested to change the email address associated with your Entry account.
          <br />
          To complete this process, please click on the verification link below.
        </P>
        <P>
          This magic link will expire in <Bold>30 minutes</Bold>.
        </P>
        <Button href={props.url}>Verify and set up a new email address</Button>
      </Content>
    </Template>
  );
}
