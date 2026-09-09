declare module "@joplin/turndown-plugin-gfm" {
  import type TurndownService from "turndown";
  type Plugin = (service: TurndownService) => void;
  const plugin: { gfm: Plugin; tables: Plugin; strikethrough: Plugin; taskListItems: Plugin; highlightedCodeBlock: Plugin };
  export default plugin;
}
