import {
  BlockTypeSelect,
  BoldItalicUnderlineToggles,
  ChangeCodeMirrorLanguage,
  CodeToggle,
  ConditionalContents,
  CreateLink,
  DiffSourceToggleWrapper,
  HighlightToggle,
  InsertCodeBlock,
  InsertFrontmatter,
  InsertImage,
  InsertTable,
  InsertThematicBreak,
  ListsToggle,
  Separator,
  StrikeThroughSupSubToggles,
  UndoRedo,
  codeBlockPlugin,
  codeMirrorPlugin,
  diffSourcePlugin,
  frontmatterPlugin,
  headingsPlugin,
  imagePlugin,
  linkDialogPlugin,
  linkPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  quotePlugin,
  tablePlugin,
  thematicBreakPlugin,
  toolbarPlugin,
} from '@mdxeditor/editor';
import { isSafeMarkdownLink } from './markdownPreview';

export function createMdxEditorPlugins(diffMarkdown: string) {
  return [
    toolbarPlugin({
      toolbarContents: () => (
        <DiffSourceToggleWrapper>
          <ConditionalContents
            options={[
              {
                when: (editorInFocus) => editorInFocus?.editorType === 'codeblock',
                contents: () => <ChangeCodeMirrorLanguage />,
              },
              {
                fallback: () => (
                  <>
                    <UndoRedo />
                    <Separator />
                    <BoldItalicUnderlineToggles />
                    <CodeToggle />
                    <HighlightToggle />
                    <Separator />
                    <StrikeThroughSupSubToggles />
                    <Separator />
                    <ListsToggle />
                    <Separator />
                    <BlockTypeSelect />
                    <Separator />
                    <CreateLink />
                    <InsertImage />
                    <Separator />
                    <InsertTable />
                    <InsertThematicBreak />
                    <Separator />
                    <InsertCodeBlock />
                    <Separator />
                    <InsertFrontmatter />
                  </>
                ),
              },
            ]}
          />
        </DiffSourceToggleWrapper>
      ),
    }),
    headingsPlugin(),
    listsPlugin(),
    quotePlugin(),
    thematicBreakPlugin(),
    linkPlugin({ disableAutoLink: true, validateUrl: isSafeMarkdownLink }),
    linkDialogPlugin(),
    imagePlugin(),
    tablePlugin(),
    codeBlockPlugin({ defaultCodeBlockLanguage: '' }),
    codeMirrorPlugin({
      autoLoadLanguageSupport: false,
      codeBlockLanguages: {
        '': 'Plain text',
        bash: 'Bash',
        css: 'CSS',
        html: 'HTML',
        js: 'JavaScript',
        json: 'JSON',
        md: 'Markdown',
        python: 'Python',
        sql: 'SQL',
        ts: 'TypeScript',
        tsx: 'TypeScript (React)',
      },
    }),
    frontmatterPlugin(),
    diffSourcePlugin({ viewMode: 'rich-text', diffMarkdown }),
    markdownShortcutPlugin(),
  ];
}
