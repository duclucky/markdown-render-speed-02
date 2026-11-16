// A fast CommonMark 0.31.2 + GFM renderer.
//
// parse(markdown) returns exactly the HTML that marked 18.1.3 renders with
// its default options (gfm on, breaks off, pedantic off, async off). The
// design follows the same two-phase shape every block parser in this family
// uses, but it is written from scratch for speed:
//
//   - Phase 1 walks the source once and records lightweight block records
//     (type, raw span, inline source). No token objects are built for
//     inline content, and link reference definitions are collected here,
//     so a reference defined later in the document still resolves.
//   - Phase 2 renders the inline source of every queued block straight to
//     HTML, then walks the block records and emits the document.
//
// Inline rendering is fused tokenize-and-render: constructs are recognised
// and emitted in one left-to-right pass, with a fast path that copies a
// whole run of plain text (escaping it once) instead of stepping through
// it character by character. Emphasis, strong emphasis and strikethrough
// use the delimiter-run algorithm from the spec, with links, code spans,
// raw HTML and escapes masked out of the delimiter scan, exactly as the
// reference does.

function edit(re, flags) {
  let src = typeof re === 'string' ? re : re.source;
  const api = {
    replace(name, val) {
      let v = typeof val === 'string' ? val : val.source;
      // A spliced pattern loses its start anchor: inside the host pattern
      // the anchor would pin the wrong position.
      v = v.replace(/(^|[^\[])\^/g, '$1');
      src = src.replace(name, v);
      return api;
    },
    rx() {
      return new RegExp(src, flags);
    },
  };
  return api;
}

// ---------------------------------------------------------------------------
// Small shared patterns
// ---------------------------------------------------------------------------

const MISC = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  listItemRegex: (bull) => new RegExp(`^( {0,3}${bull})((?:[\t ][^\\n]*)?(?:\\n|$))`),
};

function cachedIndentRegex(make) {
  const cache = [];
  return (indent) => {
    const idx = Math.max(0, Math.min(3, indent - 1));
    let re = cache[idx];
    if (!re) {
      re = make(idx);
      cache[idx] = re;
    }
    return re;
  };
}

MISC.nextBulletRegex = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`));
MISC.hrRegex = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`));
MISC.fencesBeginRegex = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}(?:\`\`\`|~~~)`));
MISC.headingBeginRegex = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}#{1,6}(?:\\s|$)`));
MISC.htmlBeginRegex = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}(?:</?(?:${TAG_LIST})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
MISC.blockquoteBeginRegex = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}>`));

// The tag names that can start an HTML block (CommonMark section 4.6).
const TAG_LIST = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';

// ---------------------------------------------------------------------------
// Block-level patterns (GFM set)
// ---------------------------------------------------------------------------

const BLOCK_NEWLINE = /^(?:[ \t]*(?:\n|$))+/;
const BLOCK_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const BLOCK_FENCES = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const BLOCK_HR = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const BLOCK_HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const BLOCK_BULLET = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const BLOCK_TEXT = /^[^\n]+/;
const BLOCK_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;

const LHEADING_CORE = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const LHEADING_GFM = edit(LHEADING_CORE)
  .replace(/bull/g, BLOCK_BULLET)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .rx();

const BLOCK_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const BLOCK_DEF = edit(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .replace('label', BLOCK_LABEL)
  .replace('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .rx();

const BLOCK_LIST = edit(/^(bull)([ \t][^\n]*?)?(?:\n|$)/)
  .replace(/bull/g, BLOCK_BULLET)
  .rx();

const BLOCK_HTML = edit(
  '^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)' // (1)
  + '|comment[^\\n]*(\\n+|$)' // (2)
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)' // (3)
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)' // (4)
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)' // (5)
  + '|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)' // (6)
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)' // (7) open tag
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)' // (7) closing tag
  + ')', 'i')
  .replace('comment', BLOCK_COMMENT)
  .replace('tag', TAG_LIST)
  .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .rx();

const GFM_TABLE = edit(
  '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
  .replace('hr', BLOCK_HR)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', TAG_LIST)
  .rx();

// A paragraph: lines that run on until a blank line or a block start that
// may interrupt one. `listInterrupt` differs between the top level (only
// a non-empty list starting at 1 interrupts) and a block quote (any bare
// marker ends the lazy paragraph).
const PARA_CORE = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
function makeParagraph(listInterrupt) {
  return edit(PARA_CORE)
    .replace('hr', BLOCK_HR)
    .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('|lheading', '')
    .replace('|table', '')
    .replace('blockquote', ' {0,3}>')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', listInterrupt)
    .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
    .replace('tag', TAG_LIST)
    .rx();
}
const PARA_GFM = edit(PARA_CORE)
  .replace('hr', BLOCK_HR)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('|lheading', '')
  .replace('table', GFM_TABLE)
  .replace('blockquote', ' {0,3}>')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', TAG_LIST)
  .rx();
const PARA_QUOTE = makeParagraph(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/);

const BLOCKQUOTE_RE = edit(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/)
  .replace('paragraph', PARA_QUOTE)
  .rx();

// ---------------------------------------------------------------------------
// Inline-level patterns (GFM set)
// ---------------------------------------------------------------------------

const INLINE_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const INLINE_CODE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const INLINE_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;

const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_OR_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_OR_SPACE = /[^\s\p{P}\p{S}]/u;
// GFM lets ~ take part in strong/em, so it is not punctuation there.
const PUNCT_GFM = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_OR_SPACE_GFM = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_OR_SPACE_GFM = /(?:[^\s\p{P}\p{S}]|~)/u;

const INLINE_PUNCTUATION = edit(/^((?![*_])punctSpace)/, 'u')
  .replace(/punctSpace/g, PUNCT_OR_SPACE).rx();

// Runs of link/code/html that emphasis must skip over.
const BLOCK_SKIP = edit(/link|precode-code|html/, 'g')
  .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .replace('precode-', '(?<!`)()')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/)
  .rx();

const EM_STRONG_L_CORE = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
const EM_STRONG_L_GFM = edit(EM_STRONG_L_CORE, 'u')
  .replace(/punct/g, PUNCT_GFM)
  .rx();

const EM_STRONG_R_AST_CORE =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)' // orphan inside strong
  + '|[^*]+(?=[^*])' // consume to delim
  + '|(?!\\*)punct(\\*+)(?=[\\s]|$)' // (1) #*** closes only
  + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)' // (2) a***# closes only
  + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)' // (3) #***a opens only
  + '|[\\s](\\*+)(?!\\*)(?=punct)' // (4) ***# opens only
  + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)' // (5) #***# either way
  + '|notPunctSpace(\\*+)(?=notPunctSpace)'; // (6) a***a either way
const EM_STRONG_R_AST_GFM = edit(EM_STRONG_R_AST_CORE, 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_OR_SPACE_GFM)
  .replace(/punctSpace/g, PUNCT_OR_SPACE_GFM)
  .replace(/punct/g, PUNCT_GFM)
  .rx();

// No rule 6 for _: a___a cannot close as emphasis.
const EM_STRONG_R_UND = edit(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)' // orphan inside strong
  + '|[^_]+(?=[^_])' // consume to delim
  + '|(?!_)punct(_+)(?=[\\s]|$)' // (1)
  + '|notPunctSpace(_+)(?!_)(?=punctSpace|$)' // (2)
  + '|(?!_)punctSpace(_+)(?=notPunctSpace)' // (3)
  + '|[\\s](_+)(?!_)(?=punct)' // (4)
  + '|(?!_)punct(_+)(?!_)(?=punct)', 'gu') // (5)
  .replace(/notPunctSpace/g, NOT_PUNCT_OR_SPACE)
  .replace(/punctSpace/g, PUNCT_OR_SPACE)
  .replace(/punct/g, PUNCT)
  .rx();

const DEL_L = edit(/^~~?(?:((?!~)punct)|[^\s~])/, 'u')
  .replace(/punct/g, PUNCT)
  .rx();
const DEL_R_CORE =
  '^[^~]+(?=[^~])' // consume to delim
  + '|(?!~)punct(~~?)(?=[\\s]|$)' // (1)
  + '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)' // (2)
  + '|(?!~)punctSpace(~~?)(?=notPunctSpace)' // (3)
  + '|[\\s](~~?)(?!~)(?=punct)' // (4)
  + '|(?!~)punct(~~?)(?!~)(?=punct)' // (5)
  + '|notPunctSpace(~~?)(?=notPunctSpace)'; // (6)
const DEL_R = edit(DEL_R_CORE, 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_OR_SPACE)
  .replace(/punctSpace/g, PUNCT_OR_SPACE)
  .replace(/punct/g, PUNCT)
  .rx();

const ANY_PUNCT = edit(/\\(punct)/, 'gu')
  .replace(/punct/g, PUNCT)
  .rx();
// Escapes outside code spans are masked; a backslash inside a code span is
// literal, so the span's backticks are masked instead.
const ANY_PUNCT_OUTSIDE_CODE = edit(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu')
  .replace(/punct/g, PUNCT)
  .rx();

const AUTOLINK = edit(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
  .rx();

const INLINE_COMMENT = edit(BLOCK_COMMENT).replace('(?:-->|$)', '-->').rx();
const INLINE_TAG = edit(
  '^comment'
    + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>' // closing tag
    + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>' // open tag
    + '|^<\\?[\\s\\S]*?\\?>' // processing instruction
    + '|^<![a-zA-Z]+\\s[\\s\\S]*?>' // declaration
    + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>') // CDATA section
  .replace('comment', INLINE_COMMENT)
  .replace('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .rx();

const INLINE_LABEL_BRACKETS = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const INLINE_LABEL = edit(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .replace('brackets', INLINE_LABEL_BRACKETS)
  .rx();

const INLINE_LINK = edit(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .replace('label', INLINE_LABEL)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .rx();

const INLINE_REFLINK = edit(/^!?\[(label)\]\[(ref)\]/)
  .replace('label', INLINE_LABEL)
  .replace('ref', BLOCK_LABEL)
  .rx();
const INLINE_NOLINK = edit(/^!?\[(ref)\](?:\[\])?/)
  .replace('ref', BLOCK_LABEL)
  .rx();

// Bounded variants for the global reflink scan used while masking: a
// candidate that can never match must not scan to the end of the source
// on every '['.
const BOUNDED_BLOCK_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const BOUNDED_INLINE_LABEL = edit(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
  .replace('brackets', INLINE_LABEL_BRACKETS)
  .rx();
const REFLINK_SEARCH = edit('reflink|nolink(?!\\()', 'g')
  .replace('reflink', edit(/^!?\[(label)\]\[(ref)\]/)
    .replace('label', BOUNDED_INLINE_LABEL)
    .replace('ref', BOUNDED_BLOCK_LABEL)
    .rx())
  .replace('nolink', edit(/^!?\[(ref)\](?:\[\])?/)
    .replace('ref', BOUNDED_BLOCK_LABEL)
    .rx())
  .rx();

const CASE_INSENSITIVE_PROTOCOL = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const EXTENDED_EMAIL = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EXTENDED_EMAIL_PROTOCOL = edit(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
  .replace(/email/g, EXTENDED_EMAIL)
  .rx();

const INLINE_URL = edit(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .replace('emailProtocol', EXTENDED_EMAIL_PROTOCOL)
  .replace('protocol', CASE_INSENSITIVE_PROTOCOL)
  .replace('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
  .rx();
const URL_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const INLINE_DEL = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;

// Where a run of plain text must stop, so the main loop can try a
// construct there. It is a superset of the reference text rule's stops:
// stopping early only costs a failed construct attempt, while skipping
// a stop would miss a construct entirely.
const TEXT_STOP = /[\\<\[`*!_~]|(?<![^\s*_~(])www\.|(?<=[^A-Za-z0-9])mailto:|(?<=[^A-Za-z0-9])xmpp:|[hH][tT][tT][pP][sS]?:\/\/|[fF][tT][pP]:\/\/|(?= {2,}\n)|(?=[A-Za-z0-9._+-]+@[A-Za-z0-9])/g;
// The same scan without the email lookahead, for runs that hold no '@':
// the lookahead is the expensive part of the scan.
const TEXT_STOP_NO_AT = /[\\<\[`*!_~]|(?<![^\s*_~(])www\.|(?<=[^A-Za-z0-9])mailto:|(?<=[^A-Za-z0-9])xmpp:|[hH][tT][tT][pP][sS]?:\/\/|[fF][tT][pP]:\/\/|(?= {2,}\n)/g;

const INLINE_TEXT_GFM = edit(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
  .replace('protocol', CASE_INSENSITIVE_PROTOCOL)
  .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
  .replace('wwwStart', '(?<![^\\s*_~(])www\\.')
  .rx();

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const escapeRepl = (ch) => ESCAPE_MAP[ch];

// Escape text for HTML. With `encode`, every & < > " ' is escaped; without
// it, an & that already starts a character reference is left alone.
function escapeHtml(html, encode) {
  if (encode) {
    if (MISC.escapeTest.test(html)) return html.replace(MISC.escapeReplace, escapeRepl);
  } else if (MISC.escapeTestNoEncode.test(html)) {
    return html.replace(MISC.escapeReplaceNoEncode, escapeRepl);
  }
  return html;
}

// Numeric character references stand for the character they name. Zero,
// out-of-range and surrogate values become the replacement character, and
// a decoded character must not join its neighbours into a new reference,
// so every other bare & is escaped here.
function decodeNumericRefs(text) {
  if (!MISC.numericCharacterReference.test(text)) return text;
  return text.replace(MISC.numericCharacterReferenceOrAmpersand, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  // encodeURI leaves these characters alone, and the %25 un-escaping
  // below puts a bare % back as it was, so such a href is already clean.
  // (The dash sits last in the class so it is a literal, not a range:
  // `$-_` would also have let `\`, `[`, `]` and `^` through unencoded.)
  if (!/[^A-Za-z0-9;,/?:@&=+$_.!~*'()#%-]/.test(href)) return href;
  try {
    href = encodeURI(href).replace(MISC.percentDecode, '%');
  } catch {
    return null;
  }
  return href;
}

function splitCells(tableRow, count) {
  // Give every cell-delimiting pipe a space before it, so it can be told
  // apart from an escaped pipe.
  const row = tableRow.replace(MISC.findPipe, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = row.split(MISC.splitPipe);
  let i = 0;
  // A first/last cell cannot be empty when it has no leading/trailing pipe.
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) {
    cells[i] = cells[i].trim().replace(MISC.slashPipe, '|');
  }
  return cells;
}

// Remove trailing `c`s; /c*$/ would be a REDOS risk on long runs.
function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) return '';
  let suffLen = 0;
  while (suffLen < l) {
    const currChar = str.charAt(l - suffLen - 1);
    if (currChar === c && !invert) suffLen++;
    else if (currChar !== c && invert) suffLen++;
    else break;
  }
  return str.slice(0, l - suffLen);
}

function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && MISC.blankLine.test(lines[end])) end--;
  if (lines.length - end <= 2) return str; // keep a single trailing blank line
  return lines.slice(0, end + 1).join('\n');
}

// A link label, normalised so definitions and references match: trimmed,
// inner whitespace collapsed, Unicode case folded through upper case
// (so ẞ meets SS) and back down to lower case.
function normalizeLabel(label) {
  return label.trim().replace(MISC.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === b[0]) level++;
    else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  return level > 0 ? -2 : -1;
}

function expandTabs(line, indent = 0) {
  let col = indent;
  let expanded = '';
  for (const char of line) {
    if (char === '\t') {
      const added = 4 - (col % 4);
      expanded += ' '.repeat(added);
      col += added;
    } else {
      expanded += char;
      col++;
    }
  }
  return expanded;
}

// One inline pass's hint: the last delimiter run that could close an
// emphasis/strong span or a strikethrough. A run can close only when it is
// not preceded by whitespace or the start of the string.
function scanClosers(src) {
  const last = { '*': -1, _: -1 };
  let lastDel = -1;
  const len = src.length;
  for (let i = 0; i < len; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < len && src[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') lastDel = i;
      else last[ch] = i;
    }
    i = j - 1;
  }
  return { last, lastDel };
}

// ---------------------------------------------------------------------------
// Per-parse state
// ---------------------------------------------------------------------------

// Records are plain objects: { t, raw, ... }. `src` is the inline source
// of a block (heading, paragraph, text, table cell); `html` is filled in
// during phase 2. Block records that hold other blocks keep them in
// `items` (block quote, list item) or `rows`/`header` (table).
function newCtx() {
  return {
    links: Object.create(null), // normalised label -> { href, title }
    hasLinks: false, // set when the first definition registers
    queue: [], // block records whose `src` still needs inline rendering
    top: true,
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
  };
}

function queueInline(ctx, rec) {
  ctx.queue.push(rec);
  return rec;
}

function infiniteLoop(byte) {
  throw new Error('Infinite loop on byte: ' + byte);
}

// ---------------------------------------------------------------------------
// Block tokenizers. Each takes the remaining source and the parse context
// and returns a block record, or undefined when it does not match.
// ---------------------------------------------------------------------------

function tokSpace(src) {
  const cap = BLOCK_NEWLINE.exec(src);
  if (cap && cap[0].length > 0) return { t: 'space', raw: cap[0] };
}

function tokCode(src) {
  const cap = BLOCK_CODE.exec(src);
  if (cap) {
    const raw = trimTrailingBlankLines(cap[0]);
    const text = raw.replace(MISC.codeRemoveIndent, '');
    return { t: 'code', raw, text, lang: '' };
  }
}

function indentCodeCompensation(raw, text) {
  const m = raw.match(MISC.indentCodeCompensation);
  if (m === null) return text;
  const indentToCode = m[1];
  return text.split('\n').map((node) => {
    const mi = node.match(MISC.beginningSpace);
    if (mi === null) return node;
    return node.slice(Math.min(mi[0].length, indentToCode.length));
  }).join('\n');
}

function tokFences(src) {
  const cap = BLOCK_FENCES.exec(src);
  if (cap) {
    const raw = cap[0];
    const text = indentCodeCompensation(raw, cap[3] || '');
    return {
      t: 'code',
      raw,
      text,
      lang: cap[2] ? cap[2].trim().replace(ANY_PUNCT, '$1') : cap[2],
    };
  }
}

function tokHeading(ctx, src) {
  const cap = BLOCK_HEADING.exec(src);
  if (cap) {
    let text = cap[2].trim();
    // Remove trailing #s, but only when a space or tab precedes them.
    if (MISC.endingHash.test(text)) {
      const trimmed = rtrim(text, '#');
      if (!trimmed || MISC.endingSpaceTabChar.test(trimmed)) text = trimmed.trim();
    }
    return queueInline(ctx, {
      t: 'heading', raw: rtrim(cap[0], '\n'), depth: cap[1].length, src: text,
    });
  }
}

function tokHr(src) {
  const cap = BLOCK_HR.exec(src);
  if (cap) return { t: 'hr', raw: rtrim(cap[0], '\n') };
}

function tokHtml(src) {
  const cap = BLOCK_HTML.exec(src);
  if (cap) {
    const raw = trimTrailingBlankLines(cap[0]);
    return {
      t: 'html', raw,
      pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style',
      src: raw,
    };
  }
}

function tokDef(src) {
  const cap = BLOCK_DEF.exec(src);
  if (cap) {
    // Outside angle brackets a destination holds only balanced parens.
    if (!MISC.startAngleBracket.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) return;
    const tag = normalizeLabel(cap[1]);
    const href = cap[2] ? cap[2].replace(MISC.hrefBrackets, '$1').replace(ANY_PUNCT, '$1') : '';
    const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(ANY_PUNCT, '$1') : cap[3];
    return { t: 'def', tag, raw: rtrim(cap[0], '\n'), href, title };
  }
}

function tokTable(ctx, src) {
  const cap = GFM_TABLE.exec(src);
  if (!cap) return;
  if (!MISC.tableDelimiter.test(cap[2])) return; // else it is a setext heading
  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(MISC.tableAlignChars, '').split('|');
  const rows = cap[3]?.trim() ? cap[3].replace(MISC.tableRowBlankLine, '').split('\n') : [];
  if (headers.length !== aligns.length) return;
  const align = [];
  for (const a of aligns) {
    if (MISC.tableAlignRight.test(a)) align.push('right');
    else if (MISC.tableAlignCenter.test(a)) align.push('center');
    else if (MISC.tableAlignLeft.test(a)) align.push('left');
    else align.push(null);
  }
  const header = [];
  for (let i = 0; i < headers.length; i++) {
    header.push(queueInline(ctx, { t: 'cell', src: headers[i], align: align[i], header: true }));
  }
  const outRows = [];
  for (const row of rows) {
    outRows.push(splitCells(row, header.length).map((cell, i) =>
      queueInline(ctx, { t: 'cell', src: cell, align: align[i], header: false })));
  }
  return { t: 'table', raw: rtrim(cap[0], '\n'), header, rows: outRows };
}

function tokLheading(ctx, src) {
  const cap = LHEADING_GFM.exec(src);
  if (cap) {
    const text = cap[1].trim();
    return queueInline(ctx, {
      t: 'heading', raw: rtrim(cap[0], '\n'),
      depth: cap[2].charAt(0) === '=' ? 1 : 2, src: text,
    });
  }
}

function tokParagraph(ctx, src) {
  const cap = PARA_GFM.exec(src);
  if (cap) {
    const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
    return queueInline(ctx, { t: 'paragraph', raw: cap[0], src: text });
  }
}

function tokText(ctx, src) {
  const cap = BLOCK_TEXT.exec(src);
  if (cap) {
    return queueInline(ctx, { t: 'text', raw: cap[0], src: cap[0] });
  }
}

// ---------------------------------------------------------------------------
// Block quote
// ---------------------------------------------------------------------------

function tokBlockquote(ctx, src) {
  const cap = BLOCKQUOTE_RE.exec(src);
  if (cap) {
    let lines = rtrim(cap[0], '\n').split('\n');
    let raw = '';
    let text = '';
    const items = [];

    while (lines.length > 0) {
      let inBlockquote = false;
      const currentLines = [];
      let i;
      for (i = 0; i < lines.length; i++) {
        // Lines up to a lazy continuation.
        if (MISC.blockquoteStart.test(lines[i])) {
          currentLines.push(lines[i]);
          inBlockquote = true;
        } else if (!inBlockquote) {
          currentLines.push(lines[i]);
        } else {
          break;
        }
      }
      lines = lines.slice(i);

      const currentRaw = currentLines.join('\n');
      const currentText = currentRaw
        // A tab after the marker runs to the next tab stop; the marker
        // only consumes one space of it, the rest is content.
        .replace(
          MISC.blockquoteMarkerWhitespace,
          (_, marker, whitespace) => marker + expandTabs(whitespace, marker.length),
        )
        // Precede a setext continuation with 4 spaces so it is not a setext.
        .replace(MISC.blockquoteSetextReplace, '\n    $1')
        .replace(MISC.blockquoteSetextReplace2, '');
      raw = raw ? `${raw}\n${currentRaw}` : currentRaw;
      text = text ? `${text}\n${currentText}` : currentText;

      // Parse the block quote's lines as top level blocks, merging
      // paragraphs across a lazy continuation.
      const top = ctx.top;
      ctx.top = true;
      blockTokens(currentText, items, ctx, true);
      ctx.top = top;

      if (lines.length === 0) break;
      const lastToken = items.at(-1);

      if (lastToken?.t === 'code' || lastToken?.t === 'heading' || lastToken?.t === 'hr' || lastToken?.t === 'html' || lastToken?.t === 'table') {
        // A continuation cannot follow a code block, heading, hr, html or table.
        break;
      } else if (lastToken?.t === 'blockquote') {
        // Include the continuation in the nested block quote.
        const oldToken = lastToken;
        // The continuation lines belong to the same nesting frame as the
        // nested block quote, which already had one '>' stripped, so strip
        // one marker from them too.
        const continuation = lines.join('\n');
        const newText = oldToken.raw + '\n' + continuation.replace(MISC.blockquoteSetextReplace2, '');
        const newToken = tokBlockquote(ctx, newText);
        items[items.length - 1] = newToken;

        // Only the lines the nested block quote actually consumed belong
        // in `raw`; unconsumed trailing lines stay for the outer lexer.
        const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
        const leftoverCount = leftover ? leftover.split('\n').length : 0;
        const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
        if (consumed.length > 0) raw = `${raw}\n${consumed.join('\n')}`;
        text = text.substring(0, text.length - oldToken.text.length) + newToken.text;

        lines = lines.slice(consumed.length);
        if (lines.length > 0 && MISC.blockquoteStart.test(lines[0])) continue;
        break;
      } else if (lastToken?.t === 'list') {
        // Include the continuation in the nested list.
        const oldToken = lastToken;
        const newText = oldToken.raw + '\n' + lines.join('\n');
        const newToken = tokList(ctx, newText);
        items[items.length - 1] = newToken;

        // The list raw has no '>' markers, so count the continuation
        // lines the list took and add those lines instead.
        const consumedCount = newToken.raw.length > oldToken.raw.length
          ? newText.slice(oldToken.raw.length + 1, newToken.raw.length).split('\n').length
          : 0;
        if (consumedCount > 0) {
          const consumed = lines.slice(0, consumedCount).join('\n');
          raw = `${raw}\n${consumed}`;
          text = `${text}\n${consumed}`;
        }
        lines = lines.slice(consumedCount);
        continue;
      }
    }

    return { t: 'blockquote', raw, text, items };
  }
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

// Does `raw` end with a double blank line (/\n[ \t]*\n[ \t]*$/), checked
// from the end instead of with a regex over the whole string?
function endsWithDoubleBlank(raw) {
  let e = raw.length;
  while (e > 0 && (raw.charCodeAt(e - 1) === 32 || raw.charCodeAt(e - 1) === 9)) e--;
  if (e === 0 || raw.charCodeAt(e - 1) !== 10) return false;
  e--;
  while (e > 0 && (raw.charCodeAt(e - 1) === 32 || raw.charCodeAt(e - 1) === 9)) e--;
  return e > 0 && raw.charCodeAt(e - 1) === 10;
}

function tokList(ctx, src) {
  let cap = BLOCK_LIST.exec(src);
  if (cap) {
    const listSrc = src;
    const taken = () => listSrc.length - src.length;
    let bull = cap[1].trim();
    const isordered = bull.length > 1;

    const list = {
      t: 'list', raw: '', ordered: isordered,
      start: isordered ? +bull.slice(0, -1) : '', loose: false, items: [],
    };

    bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;

    const itemRegex = MISC.listItemRegex(bull);
    let endsWithBlankLine = false;

    while (src) {
      let endEarly = false;
      let itemContents = '';
      if (!(cap = itemRegex.exec(src))) break;
      if (BLOCK_HR.test(src)) break; // the bullet was actually an hr

      const itemStart = taken();
      src = src.substring(cap[0].length);

      const firstNl = cap[2].indexOf('\n');
      const firstLine = firstNl === -1 ? cap[2] : cap[2].slice(0, firstNl);
      const bulletIndent = cap[1].length;
      let line = firstLine.includes('\t')
        ? firstLine.replace(MISC.leadingSpaceTab, (ws) => expandTabs(ws, bulletIndent))
        : firstLine;
      const srcNl = src.indexOf('\n');
      let nextLine = srcNl === -1 ? src : src.slice(0, srcNl);
      let blankLine = !line.trim();

      let indent = 0;
      if (blankLine) {
        indent = bulletIndent + 1;
      } else {
        indent = line.search(MISC.nonSpaceChar); // first non-space char
        indent = indent > 4 ? 1 : indent; // > 4 spaces is indented code, count as 1
        itemContents = line.slice(indent);
        indent += bulletIndent;
      }

      if (blankLine && MISC.blankLine.test(nextLine)) {
        // Items begin with at most one blank line.
        src = src.substring(nextLine.length + 1);
        endEarly = true;
      }

      if (!endEarly) {
        const nextBulletRegex = MISC.nextBulletRegex(indent);
        const hrRegex = MISC.hrRegex(indent);
        const fencesBeginRegex = MISC.fencesBeginRegex(indent);
        const headingBeginRegex = MISC.headingBeginRegex(indent);
        const htmlBeginRegex = MISC.htmlBeginRegex(indent);
        const blockquoteBeginRegex = MISC.blockquoteBeginRegex(indent);

        while (src) {
          const rawNl = src.indexOf('\n');
          const rawLine = rawNl === -1 ? src : src.slice(0, rawNl);
          nextLine = rawLine;
          // First significant character of the line (space and tab do
          // not count). Only a few characters can start a block that
          // ends this item, so the rest never reach a regex.
          let p = 0;
          while (p < nextLine.length && (nextLine.charCodeAt(p) === 32 || nextLine.charCodeAt(p) === 9)) p++;
          const firstCh = nextLine.charAt(p);
          const tabIdx = nextLine.indexOf('\t');
          const tabInLead = tabIdx !== -1 && tabIdx < p;
          let nextLineWithoutTabs = nextLine;
          let firstNS = p;
          if (tabInLead) {
            nextLineWithoutTabs = nextLine.replace(MISC.leadingSpaceTab, (ws) => expandTabs(ws));
            firstNS = nextLineWithoutTabs.search(MISC.nonSpaceChar);
          }

          if (firstCh === '`' || firstCh === '~') {
            if (fencesBeginRegex.test(nextLine)) break;
          } else if (firstCh === '#') {
            if (headingBeginRegex.test(nextLine)) break;
          } else if (firstCh === '<') {
            if (htmlBeginRegex.test(nextLine)) break;
          } else if (firstCh === '>') {
            if (blockquoteBeginRegex.test(nextLine)) break;
          } else if (firstCh === '-' || firstCh === '*' || firstCh === '+'
            || (firstCh >= '0' && firstCh <= '9')) {
            if (nextBulletRegex.test(nextLine)) break;
            if (hrRegex.test(nextLine)) break;
          } else if (firstCh === '_') {
            if (hrRegex.test(nextLine)) break;
          }

          const isBlank = p === nextLine.length;
          if (firstNS >= indent || isBlank) { // Dedent if possible
            itemContents += '\n' + nextLineWithoutTabs.slice(indent);
          } else {
            // Not enough indentation.
            if (blankLine) break;
            // A paragraph continuation, unless the last line was a
            // different block level element.
            if (line.replace(MISC.tabCharGlobal, '    ').search(MISC.nonSpaceChar) >= 4) break; // indented code block
            if (fencesBeginRegex.test(line)) break;
            if (headingBeginRegex.test(line)) break;
            if (htmlBeginRegex.test(line)) break;
            if (hrRegex.test(line)) break;

            // A lazy continuation can look like a setext underline once
            // list indentation is removed. Keep it in the paragraph.
            const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine)
              && LHEADING_GFM.test(`${line}\n${nextLine}`);
            const continuation = setextContinuation
              ? `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}`
              : nextLine;
            itemContents += '\n' + continuation;
          }

          blankLine = isBlank;
          src = src.substring(rawLine.length + 1);
          line = nextLineWithoutTabs.slice(indent);
        }
      }

      const raw = listSrc.slice(itemStart, taken());

      if (!list.loose) {
        if (endsWithBlankLine) list.loose = true;
        else if (endsWithDoubleBlank(raw)) endsWithBlankLine = true;
      }

      list.items.push({
        t: 'list_item', raw,
        task: MISC.listIsTask.test(itemContents),
        loose: false, text: itemContents, items: [],
      });
    }

    // Do not consume newlines at the end of the final item.
    const lastItem = list.items.at(-1);
    if (lastItem) {
      lastItem.raw = lastItem.raw.trimEnd();
      lastItem.text = lastItem.text.trimEnd();
    } else {
      return; // not a list: there were no items
    }
    list.raw = listSrc.slice(0, taken()).trimEnd();

    // Item child blocks are lexed here, once the final item is trimmed.
    // First pass: lex items and settle list.loose from the spacers.
    for (const item of list.items) {
      ctx.top = false;
      blockTokens(item.text, item.items, ctx);

      if (!list.loose) {
        const spacers = item.items.filter((r) => r.t === 'space');
        const hasMultipleLineBreaks = spacers.length > 0 && spacers.some((r) => MISC.anyLine.test(r.raw));
        list.loose = hasMultipleLineBreaks;
      }
    }

    // Second pass: place task checkboxes using the final list.loose.
    for (const item of list.items) {
      const itemToken = item.items[0];
      if (item.task && (itemToken?.t === 'text' || itemToken?.t === 'paragraph')) {
        // Remove the checkbox markdown from the item's blocks.
        item.text = item.text.replace(MISC.listReplaceTask, '');
        itemToken.raw = itemToken.raw.replace(MISC.listReplaceTask, '');
        itemToken.src = itemToken.src.replace(MISC.listReplaceTask, '');
        for (let i = ctx.queue.length - 1; i >= 0; i--) {
          if (MISC.listIsTask.test(ctx.queue[i].src)) {
            ctx.queue[i].src = ctx.queue[i].src.replace(MISC.listReplaceTask, '');
            break;
          }
        }

        const taskRaw = MISC.listTaskCheckbox.exec(item.raw);
        if (taskRaw) {
          const checkbox = {
            t: 'checkbox', raw: taskRaw[0] + ' ', checked: taskRaw[0] !== '[ ]',
          };
          item.checked = checkbox.checked;
          if (list.loose) {
            if (itemToken && ['paragraph', 'text'].includes(itemToken.t)) {
              // The checkbox opens the paragraph's inline content.
              itemToken.lead = (itemToken.lead || '') + checkboxHtml(checkbox.checked);
            } else {
              item.items.unshift({
                t: 'paragraph', raw: checkbox.raw, src: '', lead: checkboxHtml(checkbox.checked),
              });
            }
          } else {
            item.items.unshift(checkbox);
          }
        }
      } else if (item.task) {
        item.task = false;
      }
    }

    // A loose list makes every item loose, and its text blocks paragraphs.
    if (list.loose) {
      for (const item of list.items) {
        item.loose = true;
        for (const rec of item.items) {
          if (rec.t === 'text') rec.t = 'paragraph';
        }
      }
    }

    return list;
  }
}

function checkboxHtml(checked) {
  return '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

// ---------------------------------------------------------------------------
// The block loop
// ---------------------------------------------------------------------------

// A line can only be indented code when it starts with a tab, four
// spaces, or a tab after at most three spaces.
function startsIndentedCode(s) {
  if (s.charCodeAt(0) === 9) return true;
  let i = 0;
  while (i < 4 && s.charCodeAt(i) === 32) i++;
  if (i === 4) return true;
  return i < 4 && s.charCodeAt(i) === 9;
}

// Can the second line be a table's delimiter row? It must hold a dash,
// and a pipe or a colon.
function tablePossible(s) {
  const nl = s.indexOf('\n');
  if (nl === -1) return false;
  const nl2 = s.indexOf('\n', nl + 1);
  const line2 = nl2 === -1 ? s.slice(nl + 1) : s.slice(nl + 1, nl2);
  return line2.includes('-') && (line2.includes('|') || line2.includes(':'));
}

// Can a setext underline appear before the next blank line? The
// underline must come before one, so the search is bounded by it.
function lheadingPossible(s) {
  const blank = s.indexOf('\n\n');
  const end = blank === -1 ? s.length : blank;
  return /\n {0,3}(?:=+|-+)[ \t]*(?:\n|$)/.test(s.slice(0, end));
}

function blockTokens(src, out, ctx, lastParagraphClipped = false) {
  let srcLength = Infinity;
  while (src) {
    if (src.length < srcLength) {
      srcLength = src.length;
    } else {
      infiniteLoop(src.charCodeAt(0));
      break;
    }

    // Dispatch on the first significant character (after at most three
    // leading spaces): most block patterns can only start on one, so
    // the rest are never even tried. The order below is the reference's
    // order, restricted to the patterns each character allows.
    let k = 0;
    while (k < 3 && src.charCodeAt(k) === 32) k++;
    const c = src.charAt(k);
    const c0 = src.charCodeAt(0);
    const isBlankStart = c0 === 10 || c0 === 32 || c0 === 9;

    let rec;

    // newline
    if (isBlankStart && (rec = tokSpace(src))) {
      src = src.substring(rec.raw.length);
      const lastToken = out.at(-1);
      if (rec.raw.length === 1 && lastToken !== undefined) {
        // A single \n as a spacer terminates the last line; move it there
        // so no extra paragraph tags appear.
        lastToken.raw += '\n';
      } else {
        out.push(rec);
      }
      continue;
    }

    // indented code
    if (startsIndentedCode(src) && (rec = tokCode(src))) {
      src = src.substring(rec.raw.length);
      const lastToken = out.at(-1);
      // An indented code block cannot interrupt a paragraph.
      if (lastToken?.t === 'paragraph' || lastToken?.t === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + rec.raw;
        lastToken.src += '\n' + rec.text;
      } else {
        out.push(rec);
      }
      continue;
    }

    // fenced code
    if ((c === '`' || c === '~') && (rec = tokFences(src))) {
      src = src.substring(rec.raw.length);
      out.push(rec);
      continue;
    }

    // ATX heading
    if (c === '#' && (rec = tokHeading(ctx, src))) {
      src = src.substring(rec.raw.length);
      out.push(rec);
      continue;
    }

    // thematic break
    if ((c === '-' || c === '_' || c === '*') && (rec = tokHr(src))) {
      src = src.substring(rec.raw.length);
      out.push(rec);
      continue;
    }

    // block quote
    if (c === '>' && (rec = tokBlockquote(ctx, src))) {
      src = src.substring(rec.raw.length);
      out.push(rec);
      continue;
    }

    // list
    if ((c === '-' || c === '*' || c === '+' || (c >= '0' && c <= '9')) && (rec = tokList(ctx, src))) {
      src = src.substring(rec.raw.length);
      out.push(rec);
      continue;
    }

    // html block
    if (c === '<' && (rec = tokHtml(src))) {
      src = src.substring(rec.raw.length);
      out.push(rec);
      continue;
    }

    // link reference definition
    if (c === '[' && (rec = tokDef(src))) {
      src = src.substring(rec.raw.length);
      const lastToken = out.at(-1);
      if (lastToken?.t === 'paragraph' || lastToken?.t === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + rec.raw;
        lastToken.src += '\n' + rec.raw;
      } else {
        // The first definition of a label wins; a later one still
        // consumes its text.
        if (!ctx.links[rec.tag]) {
          ctx.links[rec.tag] = { href: rec.href, title: rec.title };
          ctx.hasLinks = true;
        }
        out.push(rec);
      }
      continue;
    }

    // GFM table
    if (tablePossible(src) && (rec = tokTable(ctx, src))) {
      src = src.substring(rec.raw.length);
      out.push(rec);
      continue;
    }

    // setext heading
    if (lheadingPossible(src) && (rec = tokLheading(ctx, src))) {
      src = src.substring(rec.raw.length);
      out.push(rec);
      continue;
    }

    // top-level paragraph
    if (ctx.top && (rec = tokParagraph(ctx, src))) {
      const lastToken = out.at(-1);
      if (lastParagraphClipped && lastToken?.t === 'paragraph') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + rec.raw;
        lastToken.src += '\n' + rec.src;
        ctx.queue.pop(); // drop the new paragraph's queued inline run
      } else {
        out.push(rec);
      }
      lastParagraphClipped = false;
      src = src.substring(rec.raw.length);
      continue;
    }

    // text (only reached when not at the top level)
    if (rec = tokText(ctx, src)) {
      src = src.substring(rec.raw.length);
      const lastToken = out.at(-1);
      if (lastToken?.t === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + rec.raw;
        lastToken.src += '\n' + rec.src;
        ctx.queue.pop(); // drop the new text run's queued inline run
      } else {
        out.push(rec);
      }
      continue;
    }

    if (src) {
      infiniteLoop(src.charCodeAt(0));
      break;
    }
  }

  ctx.top = true;
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(markdown) {
  const ctx = newCtx();
  const src = markdown.replace(MISC.carriageReturn, '\n');
  const blocks = [];
  blockTokens(src, blocks, ctx);

  // Inline rendering runs only after every block is lexed, so a link
  // reference defined anywhere in the document resolves. An inline
  // <pre>, <code>, <kbd> or <script> left open ends with the block
  // holding it, so the raw-block flag is reset for every run.
  for (let i = 0; i < ctx.queue.length; i++) {
    const rec = ctx.queue[i];
    ctx.inRawBlock = false;
    rec.html = renderInline(rec.src, ctx, false);
  }

  return renderBlocks(blocks);
}

// ---------------------------------------------------------------------------
// Inline rendering
// ---------------------------------------------------------------------------

// The at-position versions of the anchored patterns above: the leading ^
// (and any ^ after an alternation) is dropped and the sticky flag added,
// so each pattern matches exactly at the position the loop is standing on.
function stickyOf(re) {
  return new RegExp(re.source.replace(/(^|\|)\^/g, '$1'), re.flags + 'y');
}
const ESCAPE_S = stickyOf(INLINE_ESCAPE);
const CODE_S = stickyOf(INLINE_CODE);
const BR_S = stickyOf(INLINE_BR);
const AUTOLINK_S = stickyOf(AUTOLINK);
const TAG_S = stickyOf(INLINE_TAG);
const LINK_S = stickyOf(INLINE_LINK);
const REFLINK_S = stickyOf(INLINE_REFLINK);
const NOLINK_S = stickyOf(INLINE_NOLINK);
const URL_S = stickyOf(INLINE_URL);
const DEL_S = stickyOf(INLINE_DEL);
const DEL_L_S = stickyOf(DEL_L);
const EM_L_S = stickyOf(EM_STRONG_L_GFM);

// Does this link text already hold a link? An image does not count: an
// image may hold a link, a link may not.
function linkInText(text, ctx) {
  if (!text.includes('[')) return false;
  for (const match of text.matchAll(BLOCK_SKIP)) {
    if (INLINE_LINK.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of text.matchAll(REFLINK_SEARCH)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!' || !Object.hasOwn(ctx.links, normalizeLabel(match0.slice(refStart + 1, -1)))) continue;
    // A candidate holding a link is not a link either, so it does not count.
    if (refStart > 1 && linkInText(match0.slice(1, refStart - 1), ctx)) continue;
    return true;
  }
  return false;
}

// Mask links, code, HTML and escapes so the emphasis and strikethrough
// scans do not see their delimiters inside them. Every mask keeps the
// length it replaces: emStrong and del line the masked source up with
// the real one by slicing from the end.
function maskSrc(src, ctx) {
  // Fast path: with no bracket, backtick, angle bracket or backslash
  // there is nothing here to mask.
  if (!src.includes('[') && !src.includes('`') && !src.includes('<') && !src.includes('\\')) return src;
  let maskedSrc = src;

  // A reference link needs a `]` that is not followed by `(` (an inline
  // link's `](` cannot be one). Without one, the search cannot match.
  if (ctx.hasLinks && src.includes('[') && /\](?!\()/.test(src)) {
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!Object.hasOwn(ctx.links, normalizeLabel(match0.slice(refStart + 1, -1)))) return match0;
      // A candidate whose text already holds a link never becomes a
      // link, so flattening the whole span would hide the emphasis
      // that does still apply inside it. Mask the links it holds.
      // Images are exempt: their text is flattened into an alt attribute.
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(text, ctx)) {
          return '[' + text.replace(REFLINK_SEARCH, maskReflink)
            + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    maskedSrc = maskedSrc.replace(REFLINK_SEARCH, maskReflink);
  }

  // Mask out escaped characters. A backslash inside a code span is
  // literal, not an escape, so the span's backticks are masked instead
  // and blockSkip still skips all of it.
  if (src.includes('\\') || src.includes('`')) {
    maskedSrc = maskedSrc.replace(ANY_PUNCT_OUTSIDE_CODE, (match0, code, punct) => {
      if (punct) return '+'.repeat(match0.length);
      if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      return match0;
    });
  }

  // Mask out links, code spans and HTML. A link needs `](`, a code
  // span a backtick, HTML a `<`.
  if (src.includes('](') || src.includes('`') || src.includes('<')) {
    maskedSrc = maskedSrc.replace(BLOCK_SKIP, (match0) => '[' + 'a'.repeat(match0.length - 2) + ']');
  }

  return maskedSrc;
}

function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') {
      i++;
      continue;
    }
    if (label[i] === '`') {
      const code = INLINE_CODE.exec(label.slice(i));
      if (code) {
        i += code[0].length - 1;
        continue;
      }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = INLINE_TAG.exec(tokenSrc) || AUTOLINK.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

// The HTML for a link or an image once its label has been rendered.
// `inner` is the label rendered in HTML mode (a link) or in text mode
// (an image's alt text). In text mode a link is just its inner text.
function linkHtml(href, title, text, inner, autolink, plain) {
  if (plain) return inner;
  const parsedText = autolink ? escapeHtml(text, true) : inner;
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) return parsedText;
  const h = escapeHtml(cleanHref, autolink);
  let out = '<a href="' + h + '"';
  if (title) out += ' title="' + escapeHtml(title) + '"';
  out += '>' + parsedText + '</a>';
  return out;
}

function imageHtml(href, title, altText, plain) {
  if (plain) return altText;
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) return escapeHtml(altText);
  let out = `<img src="${escapeHtml(cleanHref)}" alt="${escapeHtml(altText)}"`;
  if (title) out += ` title="${escapeHtml(title)}"`;
  out += '>';
  return out;
}

// Render a link or image token: lex its label (in text mode for an
// image's alt text), refuse a link whose label holds another link, and
// report the link back. Returns null when the label kills the link.
function outputLink(cap, link, raw, ctx, plain) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(MISC.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';

  const outerInLink = ctx.inLink;
  const outerLinkEmitted = ctx.linkEmitted;
  const outerInRawBlock = ctx.inRawBlock;
  ctx.inLink = true;
  ctx.linkEmitted = false;
  const inner = renderInline(text, ctx, isImage ? true : plain);
  const textHasLink = ctx.linkEmitted;
  ctx.linkEmitted = outerLinkEmitted;
  ctx.inLink = outerInLink;

  if (!isImage) {
    // Links may not contain other links, at any level of nesting.
    // Bail so the caller falls through to text and the inner link is kept.
    if (textHasLink) {
      ctx.inRawBlock = outerInRawBlock;
      return null;
    }
    ctx.linkEmitted = true;
  }

  const html = isImage
    ? imageHtml(href, title, inner, plain)
    : linkHtml(href, title, text, inner, false, plain);
  return { len: raw.length, html };
}

function linkAt(src, i, ctx, plain) {
  // Without a ')' ahead the link pattern cannot match; skipping it
  // avoids its quadratic backtracking over unterminated links.
  if (ctx.linkParenPossible === false) return null;
  LINK_S.lastIndex = i;
  const cap = LINK_S.exec(src);
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src, cap[1], i + labelStart)) return null;

  const trimmedUrl = cap[2].trim();
  if (MISC.startAngleBracket.test(trimmedUrl)) {
    // CommonMark requires matching angle brackets.
    if (!MISC.endAngleBracket.test(trimmedUrl)) return null;
    // The ending angle bracket cannot be escaped.
    const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return null;
  } else {
    // Find the closing parenthesis.
    const lastParenIndex = findClosingBracket(cap[2], '()');
    if (lastParenIndex === -2) return null; // more opens than closes
    if (lastParenIndex > -1) {
      const start = cap[0].indexOf('!') === 0 ? 5 : 4;
      const linkLen = start + cap[1].length + lastParenIndex;
      cap[2] = cap[2].substring(0, lastParenIndex);
      cap[0] = cap[0].substring(0, linkLen).trim();
      cap[3] = '';
    }
  }
  // The ')' that ends the match is the link closer only when it is not
  // escaped: `[foo](/url\)` has no closer.
  const unescaped = rtrim(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - unescaped.length) % 2 === 0) return null;

  let href = cap[2];
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  href = href.trim();
  if (MISC.startAngleBracket.test(href)) href = href.slice(1, -1);
  return outputLink(cap, {
    href: href ? href.replace(ANY_PUNCT, '$1') : href,
    title: title ? title.replace(ANY_PUNCT, '$1') : title,
  }, cap[0], ctx, plain);
}

function reflinkAt(src, i, ctx, plain) {
  REFLINK_S.lastIndex = i;
  let cap = REFLINK_S.exec(src);
  if (!cap) {
    NOLINK_S.lastIndex = i;
    cap = NOLINK_S.exec(src);
  }
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src, cap[1], i + labelStart)) return null;

  const link = ctx.links[normalizeLabel(cap[2] || cap[1])];
  if (!link) return null; // not a reference: fall through to plain text
  return outputLink(cap, link, cap[0], ctx, plain);
}

function emStrong(src, i, masked, hints, ctx, plain, prevChar) {
  EM_L_S.lastIndex = i;
  let match = EM_L_S.exec(src);
  if (!match) return null;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return null;

  const delimChar = match[0][0];
  // A mid-run opener (the second star of an unmatched `**`) must only
  // pair with a delimiter that can only close, or it steals the opener
  // of a later span (`**a*b*c` must be `**a<em>b</em>c`).
  const midRun = prevChar === delimChar;

  // The start of this delimiter run may already be behind the cursor,
  // taken as text after the whole run failed to match, or used to close
  // an earlier span. Flanking and rules 9-10 are about the whole run,
  // so find its start.
  const srcStart = i;
  let runStart = srcStart;
  while (runStart > 0 && masked[runStart - 1] === delimChar) runStart--;
  const runPrevChar = [...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  // The other delimiter character counts as punctuation here (`_**a*`).
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!INLINE_PUNCTUATION.exec(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : !!INLINE_PUNCTUATION.exec(prevChar);

  // _ cannot sit between two alphanumerics.
  if (match[4] && prevChar.match(MISC.unicodeAlphaNumeric)) return null;

  const nextChar = match[1] || match[3] || '';

  if (!nextChar || !prevChar || prevPunct) {
    // Unicode counts emoji as 1 char; spread for a proper count.
    const lLength = [...match[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;

    // Rules 9-10 count the whole run, and also apply when the opener
    // could close as well (`a*b**`, where `*` is both flanks).
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim()
      && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return null;
    const endReg = delimChar === '*' ? EM_STRONG_R_AST_GFM : EM_STRONG_R_UND;
    const lastPossible = hints.last[delimChar];
    const windowStart = i + lLength;
    if (lastPossible < windowStart) return null;
    // Clip the masked source to the same section as the remaining source.
    const window = masked.slice(windowStart);
    const lastPossibleInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;

    while ((match = endReg.exec(window)) !== null) {
      if (match.index > lastPossibleInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue; // skip a single * in __abc*abc__

      rLength = [...rDelim].length;

      if (match[3] || match[4]) { // another left delimiter
        delimTotal += rLength;
        continue;
      } else if (match[5] || match[6] || openerCanClose) { // either way
        if (midRun && (match[5] || match[6])) break;
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue; // CommonMark emphasis rules 9-10
        }
      }

      delimTotal -= rLength;
      if (delimTotal > 0) continue; // not enough closing delimiters yet

      // Remove extra characters: *a*** -> *a*
      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = [...match[0]][0].length;
      const rawEnd = i + lLength + match.index + lastCharLength + rLength;
      const raw = src.slice(i, rawEnd);

      if (Math.min(lLength, rLength) % 2) {
        // An odd smallest delimiter makes emphasis.
        const text = raw.slice(1, -1);
        return { len: raw.length, html: plain ? renderInline(text, ctx, true) : `<em>${renderInline(text, ctx, plain)}</em>` };
      }
      // An even smallest delimiter makes strong emphasis.
      const text = raw.slice(2, -2);
      return { len: raw.length, html: plain ? renderInline(text, ctx, true) : `<strong>${renderInline(text, ctx, plain)}</strong>` };
    }
  }
  return null;
}

function delAt(src, i, masked, hints, ctx, plain, prevChar) {
  DEL_L_S.lastIndex = i;
  let match = DEL_L_S.exec(src);
  if (!match) return null;

  const nextChar = match[1] || '';
  if (!nextChar || !prevChar || INLINE_PUNCTUATION.exec(prevChar)) {
    const lLength = [...match[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength;

    const endReg = DEL_R;
    const lastPossible = hints.lastDel;
    const windowStart = i + lLength;
    if (lastPossible < windowStart) return null;
    const window = masked.slice(windowStart);
    const lastPossibleInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;

    while ((match = endReg.exec(window)) !== null) {
      if (match.index > lastPossibleInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;

      rLength = [...rDelim].length;
      if (rLength !== lLength) continue;

      if (match[3] || match[4]) { // another left delimiter
        delimTotal += rLength;
        continue;
      }

      delimTotal -= rLength;
      if (delimTotal > 0) continue;

      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = [...match[0]][0].length;
      const rawEnd = i + lLength + match.index + lastCharLength + rLength;
      const raw = src.slice(i, rawEnd);
      const text = raw.slice(lLength, -lLength);
      return { len: raw.length, html: plain ? renderInline(text, ctx, true) : `<del>${renderInline(text, ctx, plain)}</del>` };
    }
  }
  return null;
}

function autolinkAt(src, i, ctx, plain) {
  AUTOLINK_S.lastIndex = i;
  const cap = AUTOLINK_S.exec(src);
  if (!cap) return null;
  let text, href;
  if (cap[2] === '@') {
    text = cap[1];
    href = 'mailto:' + text;
  } else {
    text = cap[1];
    href = text;
  }
  const html = linkHtml(href, null, text, text, true, plain);
  return { len: cap[0].length, html };
}

function urlAt(src, i, ctx, plain) {
  URL_S.lastIndex = i;
  const cap = URL_S.exec(src);
  if (!cap) return null;
  let text, href;
  if (cap[2] === '@') {
    text = cap[0];
    href = 'mailto:' + text;
  } else {
    // Trim trailing punctuation the autolink must not swallow.
    let cap0 = cap[0];
    let prevCapZero;
    do {
      prevCapZero = cap0;
      cap0 = URL_BACKPEDAL.exec(cap0)?.[0] ?? '';
    } while (prevCapZero !== cap0);
    text = cap0;
    href = cap[1] === 'www.' ? 'http://' + cap0 : cap0;
  }
  const html = linkHtml(href, null, text, text, true, plain);
  return { len: text.length, html };
}

// The main inline pass. `plain` renders to bare text (an image's alt
// text) instead of HTML; tokenisation is identical either way.
function renderInline(src, ctx, plain) {
  // One paren scan per inline run, shared with linkAt: without a ')'
  // ahead the link pattern cannot match. A nested run receives a
  // substring of the outer run, so if the outer had none, neither does
  // this one: skip the scan in that case.
  const prevLinkParenPossible = ctx.linkParenPossible;
  ctx.linkParenPossible = prevLinkParenPossible && src.includes(')');
  // No finally: if the inner pass throws, the whole parse is abandoned
  // and this context with it, so there is nothing left to restore.
  const out = renderInlineInner(src, ctx, plain);
  ctx.linkParenPossible = prevLinkParenPossible;
  return out;
}

function renderInlineInner(src, ctx, plain) {
  // Fast path: a run with no backslash, angle bracket, bracket, backtick,
  // star, underscore, tilde, bang, @, www. link, :// link or hard break
  // holds no construct at all, so it is plain text: decode it and escape
  // it once instead of stepping through it.
  if (!/[\\<\[`*!_~@]|www\.|:\/\/| {2,}\n/.test(src)) {
    if (ctx.inRawBlock) return src;
    const decoded = decodeNumericRefs(src);
    return plain ? decoded : escapeHtml(decoded);
  }

  // The masked source is only read by emStrong and del, which need a *,
  // _ or ~ to start. Skip building it for a run without one.
  const needsMask = src.includes('*') || src.includes('_') || src.includes('~');
  const masked = needsMask ? maskSrc(src, ctx) : src;
  const hints = needsMask ? scanClosers(masked) : null;

  const n = src.length;
  let out = '';
  let i = 0;
  let prevChar = '';
  let keepPrevChar = false;
  // Adjacent text runs are one text token: they are buffered and only
  // decoded and escaped when a construct intervenes or the run ends.
  // A run that ends in `&` must see the reference that continues in the
  // next run (`&_;` stays literal), and escaping each run alone would
  // turn that `&` into `&amp;` before the `_;` ever arrives.
  let textBuf = '';
  let bufNeedsEscape = false;
  // An extended autolink can only start on a letter, a digit, or one
  // of . _ + - (an email local part); other stops never need the try.
  // The text stop scan drops its email lookahead when the run holds no '@'.
  const stopRe = src.includes('@') ? TEXT_STOP : TEXT_STOP_NO_AT;

  while (i < n) {
    if (!keepPrevChar) prevChar = '';
    keepPrevChar = false;

    // The raw-block state from before this step: a construct may flip
    // it while rendering its nested content (a `<code>` tag, emphasis
    // holding one), but the buffered text before the construct was
    // decoded under the old state, so it is flushed under it.
    const rawBefore = ctx.inRawBlock;

    const ch = src[i];
    let r = null;
    if (ch === '\\') {
      ESCAPE_S.lastIndex = i;
      const esc = ESCAPE_S.exec(src);
      if (esc) {
        const text = esc[1];
        r = { len: esc[0].length, html: plain ? text : escapeHtml(text) };
      } else {
        BR_S.lastIndex = i;
        const br = BR_S.exec(src);
        if (br) r = { len: br[0].length, html: plain ? '' : '<br>' };
      }
    } else if (ch === '<') {
      TAG_S.lastIndex = i;
      const tag = TAG_S.exec(src);
      if (tag) {
        if (!ctx.inLink && MISC.startATag.test(tag[0])) ctx.inLink = true;
        else if (ctx.inLink && MISC.endATag.test(tag[0])) ctx.inLink = false;
        if (!ctx.inRawBlock && MISC.startPreScriptTag.test(tag[0])) ctx.inRawBlock = true;
        else if (ctx.inRawBlock && MISC.endPreScriptTag.test(tag[0])) ctx.inRawBlock = false;
        r = { len: tag[0].length, html: tag[0] };
      } else {
        r = autolinkAt(src, i, ctx, plain);
      }
    } else if (ch === '[' || (ch === '!' && src[i + 1] === '[')) {
      r = linkAt(src, i, ctx, plain) || reflinkAt(src, i, ctx, plain);
    } else if (ch === '*' || ch === '_') {
      r = emStrong(src, i, masked, hints, ctx, plain, prevChar);
    } else if (ch === '`') {
      CODE_S.lastIndex = i;
      const code = CODE_S.exec(src);
      if (code) {
        let text = code[2].replace(MISC.newLineCharGlobal, ' ');
        const hasNonSpaceChars = MISC.nonSpaceChar.test(text);
        const hasSpaceCharsOnBothEnds = MISC.startingSpaceChar.test(text) && MISC.endingSpaceChar.test(text);
        if (hasNonSpaceChars && hasSpaceCharsOnBothEnds) text = text.substring(1, text.length - 1);
        r = { len: code[0].length, html: plain ? text : `<code>${escapeHtml(text, true)}</code>` };
      }
    } else if (ch === ' ') {
      BR_S.lastIndex = i;
      const br = BR_S.exec(src);
      if (br) r = { len: br[0].length, html: plain ? '' : '<br>' };
    } else if (ch === '~') {
      r = delAt(src, i, masked, hints, ctx, plain, prevChar);
    }

    if (r) {
      const rawAfter = ctx.inRawBlock;
      ctx.inRawBlock = rawBefore;
      out = flushTextBuf(out, textBuf, bufNeedsEscape, ctx, plain);
      textBuf = '';
      bufNeedsEscape = false;
      ctx.inRawBlock = rawAfter;
      out += r.html;
      i += r.len;
      continue;
    }

    // GFM extended autolink, only outside a link.
    if (!ctx.inLink) {
      const cc = src.charCodeAt(i);
      if ((cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122)
        || cc === 46 || cc === 95 || cc === 43 || cc === 45) {
        r = urlAt(src, i, ctx, plain);
        if (r) {
          const rawAfter = ctx.inRawBlock;
          ctx.inRawBlock = rawBefore;
          out = flushTextBuf(out, textBuf, bufNeedsEscape, ctx, plain);
          textBuf = '';
          bufNeedsEscape = false;
          ctx.inRawBlock = rawAfter;
          out += r.html;
          i += r.len;
          continue;
        }
      }
    }

    // No construct matched: copy a run of plain text, up to the next
    // position where a construct could start, escaping it once.
    // A run of backticks or tildes is one unit of text: a failed code
    // span or strikethrough must not leave its second character behind
    // to open a span of its own.
    let scanFrom = i + 1;
    if (ch === '`' || ch === '~') {
      while (scanFrom < n && src[scanFrom] === ch) scanFrom++;
    }
    stopRe.lastIndex = scanFrom;
    const stop = stopRe.exec(src);
    const j = stop ? stop.index : n;
    const run = src.slice(i, j);
    textBuf += run;
    if (!bufNeedsEscape && /[&<>"']/.test(run)) bufNeedsEscape = true;
    // Track the previous character before a run of ____ started.
    if (run.charCodeAt(run.length - 1) !== 95) prevChar = run.charAt(run.length - 1);
    keepPrevChar = true;
    i = j;
  }
  out = flushTextBuf(out, textBuf, bufNeedsEscape, ctx, plain);
  return out;
}

// Flush a buffered run of adjacent text: raw HTML keeps whatever it
// was written with, everywhere else a numeric character reference
// stands for the character itself.
function flushTextBuf(out, buf, needsEscape, ctx, plain) {
  if (!buf) return out;
  if (ctx.inRawBlock) return out + buf;
  if (!needsEscape) return out + buf;
  const decoded = decodeNumericRefs(buf);
  return out + (plain ? decoded : escapeHtml(decoded));
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

function renderCode(rec) {
  const langString = (rec.lang || '').match(MISC.notSpaceStart)?.[0];
  // An empty code block has no content, so it must not gain a newline.
  const code = rec.text ? rec.text.replace(MISC.endingNewline, '') + '\n' : '';
  const body = escapeHtml(code, true);
  if (!langString) return '<pre><code>' + body + '</code></pre>\n';
  return '<pre><code class="language-' + escapeHtml(langString) + '">' + body + '</code></pre>\n';
}

function renderCell(cell) {
  const type = cell.header ? 'th' : 'td';
  const tag = cell.align ? `<${type} align="${cell.align}">` : `<${type}>`;
  return tag + cell.html + `</${type}>\n`;
}

function renderTable(rec) {
  let cell = '';
  for (let j = 0; j < rec.header.length; j++) cell += renderCell(rec.header[j]);
  let header = `<tr>\n${cell}</tr>\n`;

  let body = '';
  for (let j = 0; j < rec.rows.length; j++) {
    const row = rec.rows[j];
    cell = '';
    for (let k = 0; k < row.length; k++) cell += renderCell(row[k]);
    body += `<tr>\n${cell}</tr>\n`;
  }
  if (body) body = `<tbody>${body}</tbody>`;

  return '<table>\n<thead>\n' + header + '</thead>\n' + body + '</table>\n';
}

function renderList(rec) {
  let body = '';
  for (let j = 0; j < rec.items.length; j++) {
    const item = rec.items[j];
    body += `<li>${renderBlocks(item.items)}</li>\n`;
  }
  const type = rec.ordered ? 'ol' : 'ul';
  const startAttr = (rec.ordered && rec.start !== 1) ? (' start="' + rec.start + '"') : '';
  return '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
}

function renderBlocks(blocks) {
  let out = '';
  for (let i = 0; i < blocks.length; i++) {
    const rec = blocks[i];
    switch (rec.t) {
      case 'space':
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading':
        out += `<h${rec.depth}>${rec.html}</h${rec.depth}>\n`;
        break;
      case 'code':
        out += renderCode(rec);
        break;
      case 'table':
        out += renderTable(rec);
        break;
      case 'blockquote':
        out += `<blockquote>\n${renderBlocks(rec.items)}</blockquote>\n`;
        break;
      case 'list':
        out += renderList(rec);
        break;
      case 'checkbox':
        out += checkboxHtml(rec.checked);
        break;
      case 'html':
        out += rec.src;
        break;
      case 'def':
        break;
      case 'paragraph':
        out += `<p>${rec.lead || ''}${rec.html}</p>\n`;
        break;
      case 'text':
        out += (rec.lead || '') + rec.html;
        break;
    }
  }
  return out;
}
