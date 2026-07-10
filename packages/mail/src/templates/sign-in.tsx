import { Content, OnelineCodeBlock, P, SecondaryText, Template, Title } from '../components/template';

export type SignInProps = { otp: string };

export default function SignIn(props: SignInProps) {
  return (
    <Template>
      <Title>Sign in to Entry</Title>
      <Content>
        <P>You are signing in to Entry. Here is your code:</P>
        <OnelineCodeBlock>{props.otp}</OnelineCodeBlock>
        <P>
          <SecondaryText>This code will expire in 5 minutes.</SecondaryText>
        </P>
      </Content>
    </Template>
  );
}
