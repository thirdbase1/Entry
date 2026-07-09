import { Bold, Button, Content, P, Template, Title } from '../components/template';

export type SetPasswordProps = { url: string };

export default function SetPassword(props: SetPasswordProps) {
  return (
    <Template>
      <Title>Set your Entry password</Title>
      <Content>
        <P>
          Click the button below to set your password. The magic link will expire in <Bold>30 minutes</Bold>.
        </P>
        <Button href={props.url}>Sign in to Entry</Button>
      </Content>
    </Template>
  );
}
