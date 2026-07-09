/**
 * Ported 1:1 from pages/onboarding/show-case-video.tsx — the intro video
 * that plays in the Showcase step. The video file
 * (/videos/openagent_intro.mp4) exists in the original repo's public/ dir
 * and has been copied to our public/ — confirmed present (27MB).
 */
export function ShowCaseVideo() {
  return (
    <video
      className="h-96 rounded-lg max-w-full"
      muted
      autoPlay
      loop
      controls
      src="/videos/openagent_intro.mp4"
    />
  );
}
