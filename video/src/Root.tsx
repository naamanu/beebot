import { Composition } from "remotion";
import { Tour, totalFrames } from "./Tour";

export const Root = () => (
  <>
    <Composition id="GithubTour" component={Tour} defaultProps={{ variant: "github" as const }} durationInFrames={totalFrames("github")} fps={30} width={1920} height={1080} />
    <Composition id="TweetCut" component={Tour} defaultProps={{ variant: "tweet" as const }} durationInFrames={totalFrames("tweet")} fps={30} width={1920} height={1080} />
  </>
);
