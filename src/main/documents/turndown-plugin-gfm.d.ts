/** `turndown-plugin-gfm` ships no types. It has four exports and we use one. */
declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown'

  export function gfm(service: TurndownService): void
  export function tables(service: TurndownService): void
  export function strikethrough(service: TurndownService): void
  export function taskListItems(service: TurndownService): void
}
