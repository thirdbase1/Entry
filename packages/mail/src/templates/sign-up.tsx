import { Button, Content, OnelineCodeBlock, P, SecondaryText, Template, Title } from '../components/template';

export type SignUpProps = { url: string; otp: string };

export default function SignUp(props: SignUpProps) {
  return (
    <Template>
      <Title>Sign up to Entry</Title>
      <Content>
        <P>You are signing up to Entry. Here is your code:</P>
        <OnelineCodeBlock>{props.otp}</OnelineCodeBlock>
        <P>Alternatively, you can sign up directly by clicking the magic link below:</P>
        <Button href={props.url}>Sign up with Magic Link</Button>
        <P>
          <SecondaryText>This code and link will expire in 30 minutes.</SecondaryText>
        </P>
      </Content>
    </Template>
  );
}
