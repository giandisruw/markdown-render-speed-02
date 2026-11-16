// parse.js — a dependency-free drop-in for marked 18.1.3 (default options,
// GFM on). parse(markdown) returns exactly the HTML marked renders.
//
// Written fresh for this bounty: a two-phase renderer. Phase one walks the
// source with block-level patterns and builds a small token tree, collecting
// link reference definitions as it goes. Phase two walks each token's text
// with inline patterns (escapes, code spans, emphasis, links, autolinks)
// once every definition is known, because a reference may be defined after
// the paragraph that uses it. Rendering is a straight walk over the tree.
//
// The grammar below mirrors the CommonMark 0.31.2 + GFM 0.29 rules marked
// implements, including its deliberate deviations (tables interrupting
// paragraphs, lazy blockquote continuations, task-list checkboxes).

// ---------------------------------------------------------------------------
// Small string helpers
// ---------------------------------------------------------------------------

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_TEST = /[&<>"']/;
const ESCAPE_REPLACE = /[&<>"']/g;
const ESCAPE_TEST_LOOSE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESCAPE_REPLACE_LOOSE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const NUMERIC_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMERIC_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const PERCENT25 = /%25/g;

// Escape text for HTML. With `encode`, every & < > " ' is escaped; without
// it, an & that already starts a character or entity reference is left alone.
function escHtml(s, encode) {
  if (encode) {
    return ESCAPE_TEST.test(s) ? s.replace(ESCAPE_REPLACE, (c) => ESCAPE_MAP[c]) : s;
  }
  return ESCAPE_TEST_LOOSE.test(s) ? s.replace(ESCAPE_REPLACE_LOOSE, (c) => ESCAPE_MAP[c]) : s;
}

// Numeric character references name the character they stand for. Zero,
// out-of-range and surrogate values become the replacement character, and a
// decoded & must not join its neighbours into a new reference.
function decodeNumericRefs(s) {
  if (!NUMERIC_REF.test(s)) return s;
  return s.replace(NUMERIC_REF_OR_AMP, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(PERCENT25, '%');
  } catch {
    return null;
  }
  return href;
}

// Split a table row into cells: an unescaped pipe separates cells, an
// escaped pipe stays literal, and empty outer cells from a leading or
// trailing pipe are dropped. `count` pads or trims to the header width.
function splitCells(row, count) {
  const markedRow = row.replace(/\|/g, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = markedRow.split(/ \|/);
  if (cells.length && !cells[0].trim()) cells.shift();
  if (cells.length && !cells[cells.length - 1].trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) {
    cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  }
  return cells;
}

// Remove trailing `c` characters without a regex vulnerable to REDOS.
function rtrim(s, c, invert) {
  const l = s.length;
  if (l === 0) return '';
  let suff = 0;
  while (suff < l) {
    const ch = s.charAt(l - suff - 1);
    if (ch === c && !invert) suff++;
    else if (ch !== c && invert) suff++;
    else break;
  }
  return s.slice(0, l - suff);
}

function trimTrailingBlankLines(s) {
  const lines = s.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && /^[ \t]*$/.test(lines[end])) end--;
  if (lines.length - end <= 2) return s;
  return lines.slice(0, end + 1).join('\n');
}

// A link label folds case through upper case (so ẞ meets SS), collapses
// inner whitespace runs to one space, and drops surrounding whitespace.
function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Index of the bracket that closes the pair opened at the start of `s`,
// or -1 when the brackets balance / -2 when opens outnumber closes.
// Backslash-escaped brackets do not count.
function findClosingBracket(s, b) {
  if (s.indexOf(b[0]) === -1 && s.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === b[0]) level++;
    else if (s[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  return level > 0 ? -2 : -1;
}

// Expand tabs in a line to spaces, counting columns from `indent`.
function expandTabs(line, indent = 0) {
  let col = indent;
  let out = '';
  for (const ch of line) {
    if (ch === '\t') {
      const added = 4 - (col % 4);
      out += ' '.repeat(added);
      col += added;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// Build a regex out of string fragments, splicing named placeholders with
// other fragments. A `^` inside a spliced fragment is dropped (it only
// anchored the fragment on its own).
function edit(src, flags = '') {
  let s = typeof src === 'string' ? src : src.source;
  const api = {
    sub(name, val) {
      const v = typeof val === 'string' ? val : val.source;
      s = s.replace(name, v.replace(/(^|[^\[])\^/g, '$1'));
      return api;
    },
    re() { return new RegExp(s, flags); },
  };
  return api;
}

// ---------------------------------------------------------------------------
// Shared fragments
// ---------------------------------------------------------------------------

const TAG_NAMES = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';
const COMMENT_SRC = '<!--(?:-?>|[\\s\\S]*?(?:-->|$))';
const BULLET_SRC = ' {0,3}(?:[*+-]|\\d{1,9}[.)])';
const HR_SRC = ' {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const HEADING_START = ' {0,3}#{1,6}(?:\\s|$)';
const FENCES_START = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';
const HTML_START = ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';
const ATTR_SRC = ' +[a-zA-Z:_][\\w.:-]*(?: *= *"[^"\\n]*"| *= *\'[^\'\\n]*\'| *= *[^\\s"\'=<>`]+)?';

// ---------------------------------------------------------------------------
// Block grammar (GFM)
// ---------------------------------------------------------------------------

const BLK_NEWLINE = /^(?:[ \t]*(?:\n|$))+/;
const BLK_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const BLK_FENCES = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const BLK_HR = edit('^hr').sub('hr', HR_SRC).re();
const BLK_HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const BLK_TEXT = /^[^\n]+/;

// Setext underline: the first line may not itself start a block, and the
// underline line ends the heading. GFM also lets a table delimiter
// interrupt; CommonMark does not.
const SETEXT_CORE = '^(?!bull |blockCode|fences|blockquote|heading|html|table)'
  + '((?:.|\\n(?!\\s*?\\n|bull |fences|blockquote|heading|hr|html|table))+?)'
  + '\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)';
function buildSetext(tablePart) {
  const base = edit(SETEXT_CORE)
    .sub(/bull/g, BULLET_SRC)
    .sub(/blockCode/g, '(?: {4}| {0,3}\\t)')
    .sub(/fences/g, ' {0,3}(?:`{3,}|~{3,})')
    .sub(/blockquote/g, ' {0,3}>')
    .sub(/heading/g, HEADING_START)
    // Non-capturing here: a capturing group inside the lookahead would
    // shift the text group off cap[1] and the underline off cap[2].
    .sub(/hr/g, ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)')
    .sub(/html/g, ' {0,3}<[^\\n>]+>\\n');
  // GFM keeps the '|' separator and splices the table pattern in; the
  // CommonMark form drops '|table' entirely.
  return tablePart ? base.sub(/table/g, tablePart).re() : base.sub(/\|table/g, '').re();
}
const BLK_LHEADING = buildSetext('');
const BLK_LHEADING_GFM = buildSetext(' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n');

// A link reference definition: label, destination, optional title, each
// allowed to start on the following line.
const DEF_LABEL = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const DEF_TITLE = '(?:"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\\\n]|\\n(?!\\n))*\'|\\((?:\\\\[\\s\\S]|[^()\\\\])*\\))';
const BLK_DEF = edit('^ {0,3}\\[(label)\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)'
  + '(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(title))? *(?:\\n+|$)')
  .sub('label', DEF_LABEL)
  .sub('title', DEF_TITLE)
  .re();
const BLK_LIST = edit('^(bull)([ \\t][^\\n]*?)?(?:\\n|$)').sub(/bull/g, BULLET_SRC).re();

// HTML blocks, types 1-7: script/pre/style/textarea to their closer,
// comment, processing instruction, declaration, CDATA, a block-level tag
// (runs to a blank line), or a lone open/close tag (also to a blank line).
const BLK_HTML = edit('^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)'
  + '|comment[^\\n]*(\\n+|$)'
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)'
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)'
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)'
  + '|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + ')', 'i')
  .sub('comment', COMMENT_SRC)
  .sub('tag', TAG_NAMES)
  .sub('attribute', ATTR_SRC)
  .re();

// GFM table: header line, delimiter row, then body rows until a line that
// starts another block.
const BLK_TABLE = edit('^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
  .sub('hr', HR_SRC)
  .sub('heading', HEADING_START)
  .sub('blockquote', ' {0,3}>')
  .sub('code', '(?: {4}| {0,3}\	)[^\\n]')
  .sub('fences', FENCES_START)
  .sub('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .sub('html', edit(HTML_START).sub('tag', TAG_NAMES).re())
  .re();

// Paragraph: lines that do not start a block that interrupts one. Inside a
// blockquote a bare list marker also interrupts, so it gets its own form.
function buildParagraph(listInterrupt, withTable = true) {
  const base = edit('^([^\\n]+(?:\\n(?!hr|heading|blockquote|fences|list|html|table|[ \\t]+\\n)[^\\n]+)*)')
    .sub('hr', HR_SRC)
    .sub('heading', HEADING_START)
    .sub('blockquote', ' {0,3}>')
    .sub('fences', FENCES_START)
    .sub('list', listInterrupt);
  // 'table' before 'html': the html fragment carries the tag name
  // 'table' in its list, and a plain replace would splice the table
  // pattern into the tag list instead of the lookahead. Inside a
  // blockquote a table does not interrupt a paragraph at all, so the
  // alternative is dropped there.
  if (withTable) base.sub('table', BLK_TABLE);
  else base.sub('|table', '');
  return base.sub('html', edit(HTML_START).sub('tag', TAG_NAMES).re()).re();
}
const BLK_PARAGRAPH = buildParagraph(' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]');
const BLK_PARAGRAPH_QUOTE = buildParagraph(' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)', false);

// Blockquote: `>` lines, or lazy paragraph continuation lines after them.
const BLK_BLOCKQUOTE = edit('^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(paragraph)|[^\\n]*)(?:\\n|$))+')
  .sub('paragraph', BLK_PARAGRAPH_QUOTE)
  .re();

// ---------------------------------------------------------------------------
// Inline grammar (GFM)
// ---------------------------------------------------------------------------

const INL_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const INL_CODE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const INL_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const INL_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const INL_DEL = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;

// Unicode punctuation classes. GFM treats ~ as a word character for
// emphasis purposes, so the GFM variants exclude it.
const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;
const PUNCT_GFM = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_SPACE_GFM = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE_GFM = /(?:[^\s\p{P}\p{S}]|~)/u;
const UNICODE_ALNUM = /[\p{L}\p{N}]/u;

const INL_PUNCT = edit(/^((?![*_])punctSpace)/, 'u').sub(/punctSpace/g, PUNCT_SPACE).re();
const INL_ANY_PUNCT = edit(/\\(punct)/, 'gu').sub(/punct/g, PUNCT).re();
const INL_ANY_PUNCT_OUTSIDE_CODE = edit(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu')
  .sub(/punct/g, PUNCT).re();

// Sequences emphasis skips over: [title](link), `code`, <html>.
const INL_BLOCK_SKIP = edit(/link|precode-code|html/, 'g')
  .sub('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .sub('precode-', '(?<!`)()')
  .sub('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .sub('html', /<(?! )[^<>]*?>/)
  .re();

// Left delimiter: a run of * or _ followed by punctuation or a non-space.
const EM_L_DELIM_CORE = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
const INL_EM_L_DELIM = edit(EM_L_DELIM_CORE, 'u').sub(/punct/g, PUNCT_GFM).re();

// Right delimiter: the six CommonMark flanking cases, plus the two
// "consume to the next delimiter" cases that skip orphaned runs.
const EM_R_DELIM_AST_CORE = '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)'
  + '|[^*]+(?=[^*])'
  + '|(?!\\*)punct(\\*+)(?=[\\s]|$)'
  + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)'
  + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)'
  + '|[\\s](\\*+)(?!\\*)(?=punct)'
  + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)'
  + '|notPunctSpace(\\*+)(?=notPunctSpace)';
const INL_EM_R_DELIM_AST = edit(EM_R_DELIM_AST_CORE, 'gu')
  .sub(/notPunctSpace/g, NOT_PUNCT_SPACE_GFM)
  .sub(/punctSpace/g, PUNCT_SPACE_GFM)
  .sub(/punct/g, PUNCT_GFM)
  .re();
// Underscore has no "both flanking" case: a___a cannot close emphasis.
const EM_R_DELIM_UND_CORE = '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)'
  + '|[^_]+(?=[^_])'
  + '|(?!_)punct(_+)(?=[\\s]|$)'
  + '|notPunctSpace(_+)(?!_)(?=punctSpace|$)'
  + '|(?!_)punctSpace(_+)(?=notPunctSpace)'
  + '|[\\s](_+)(?!_)(?=punct)'
  + '|(?!_)punct(_+)(?!_)(?=punct)';
const INL_EM_R_DELIM_UND = edit(EM_R_DELIM_UND_CORE, 'gu')
  .sub(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .sub(/punctSpace/g, PUNCT_SPACE)
  .sub(/punct/g, PUNCT)
  .re();

// Strikethrough delimiters, same shape as the asterisk ones.
const INL_DEL_L_DELIM = edit(/^~~?(?:((?!~)punct)|[^\s~])/, 'u').sub(/punct/g, PUNCT).re();
const DEL_R_DELIM_CORE = '^[^~]+(?=[^~])'
  + '|(?!~)punct(~~?)(?=[\\s]|$)'
  + '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)'
  + '|(?!~)punctSpace(~~?)(?=notPunctSpace)'
  + '|[\\s](~~?)(?!~)(?=punct)'
  + '|(?!~)punct(~~?)(?!~)(?=punct)'
  + '|notPunctSpace(~~?)(?=notPunctSpace)';
const INL_DEL_R_DELIM = edit(DEL_R_DELIM_CORE, 'gu')
  .sub(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .sub(/punctSpace/g, PUNCT_SPACE)
  .sub(/punct/g, PUNCT)
  .re();

const INL_AUTOLINK = edit(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .sub('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .sub('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
  .re();
const INL_COMMENT = '<!--(?:-?>|[\\s\\S]*?-->)';
const INL_TAG = edit('^comment'
  + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>'
  + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>'
  + '|^<\\?[\\s\\S]*?\\?>'
  + '|^<![a-zA-Z]+\\s[\\s\\S]*?>'
  + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>')
  .sub('comment', INL_COMMENT)
  .sub('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .re();

// Link labels nest brackets two levels deep; the third and fourth flip no
// spec example, so the pattern stops there.
const LABEL_BRACKETS = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const LABEL_INLINE = edit(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .sub('brackets', LABEL_BRACKETS)
  .re();
const LABEL_BLOCK = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const INL_LINK = edit(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .sub('label', LABEL_INLINE)
  .sub('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .sub('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .re();
const INL_REFLINK = edit(/^!?\[(label)\]\[(ref)\]/)
  .sub('label', LABEL_INLINE)
  .sub('ref', LABEL_BLOCK)
  .re();
const INL_NOLINK = edit(/^!?\[(ref)\](?:\[\])?/)
  .sub('ref', LABEL_BLOCK)
  .re();
// The search form drops the anchors and bounds the scan, so a candidate
// that can never match does not cost O(n^2) over the whole source.
const BOUNDED_BLOCK_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const BOUNDED_INLINE_LABEL = edit(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
  .sub('brackets', LABEL_BRACKETS)
  .re();
const INL_REFLINK_SEARCH = edit('reflink|nolink(?!\\()', 'g')
  .sub('reflink', edit(/^!?\[(label)\]\[(ref)\]/)
    .sub('label', BOUNDED_INLINE_LABEL)
    .sub('ref', BOUNDED_BLOCK_LABEL)
    .re())
  .sub('nolink', edit(/^!?\[(ref)\](?:\[\])?/)
    .sub('ref', BOUNDED_BLOCK_LABEL)
    .re())
  .re();

const PROTO = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const EXTENDED_EMAIL = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EMAIL_PROTOCOL = edit(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
  .sub(/email/g, EXTENDED_EMAIL)
  .re();
const INL_URL = edit(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .sub('emailProtocol', EMAIL_PROTOCOL)
  .sub('protocol', PROTO)
  .sub('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
  .re();
const INL_TEXT = edit(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
  .sub('protocol', PROTO)
  .sub(/emailProtocol/g, /(?:mailto|xmpp):/)
  .sub('wwwStart', '(?<![^\\s*_~(])www\\.')
  .re();

// Per-indent helpers for the list tokenizer.
function listItemRe(bull) {
  return new RegExp(`^( {0,3}${bull})((?:[\t ][^\n]*)?(?:\n|$))`);
}
function cachedRe(make) {
  const cache = [];
  return (indent) => {
    const idx = Math.max(0, Math.min(3, indent - 1));
    if (!cache[idx]) cache[idx] = make(idx);
    return cache[idx];
  };
}
const NEXT_BULLET_RE = cachedRe((n) => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\n|$))`));
const HR_AT_RE = cachedRe((n) => new RegExp(`^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`));
const FENCES_AT_RE = cachedRe((n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`));
const HEADING_AT_RE = cachedRe((n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`));
const HTML_AT_RE = cachedRe((n) => new RegExp(`^ {0,${n}}(?:</?(?:${TAG_NAMES})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
const QUOTE_AT_RE = cachedRe((n) => new RegExp(`^ {0,${n}}>`));

// Miscellaneous shared patterns.
const CODE_REMOVE_INDENT = /^(?: {0,3}\t| {1,4})/gm;
const INDENT_CODE_COMP = /^(\s+)(?:```)/;
const BEGINNING_SPACE = /^\s+/;
const ENDING_HASH = /#$/;
const ENDING_SPACE_TAB = /[ \t]$/;
const NON_SPACE = /[^ ]/;
const NEWLINE_GLOBAL = /\n/g;
const TAB_GLOBAL = /\t/g;
const LEADING_SPACE_TAB = /^[ \t]+/;
const BLANK_LINE = /^[ \t]*$/;
const DOUBLE_BLANK = /\n[ \t]*\n[ \t]*$/;
const QUOTE_START = /^ {0,3}>/;
const QUOTE_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const QUOTE_SETEXT2 = /^ {0,3}>[ \t]?/gm;
const QUOTE_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const LIST_NESTING = /^ {1,4}(?=( {4})*[^ ])/g;
const LIST_IS_TASK = /^\[[ xX]\][ \t]+\S/;
const LIST_TASK = /^\[[ xX]\][ \t]+/;
const LIST_TASK_BOX = /\[[ xX]\]/;
const ANY_LINE = /\n.*\n/;
const HREF_BRACKETS = /^<(.*)>$/;
const TABLE_DELIM = /[:|]/;
const TABLE_ALIGN_CHARS = /^\||\| *$/g;
const TABLE_ROW_BLANK = /\n[ \t]*$/;
const TABLE_ALIGN_RIGHT = /^ *-+: *$/;
const TABLE_ALIGN_CENTER = /^ *:-+: *$/;
const TABLE_ALIGN_LEFT = /^ *:-+ *$/;
const START_A_TAG = /^<a /i;
const END_A_TAG = /^<\/a>/i;
const START_PRE_TAG = /^<(pre|code|kbd|script)(\s|>)/i;
const END_PRE_TAG = /^<\/(pre|code|kbd|script)(\s|>)/i;
const START_ANGLE = /^</;
const END_ANGLE = />$/;
const OUTPUT_LINK_REPLACE = /\\([\[\]])/g;
const SPACE_LINE = /^ +$/gm;
const NOT_SPACE_START = /^\S*/;
const ENDING_NEWLINE = /\n$/;
const SETEXT_LINE = /^ {0,3}(?:=+|-+) *$/;

// ---------------------------------------------------------------------------
// Parse state (fresh per parse call)
// ---------------------------------------------------------------------------

function newState() {
  return {
    links: Object.create(null),
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    top: true,
    inlineQueue: [],
    hintStack: [],
  };
}

// Queue a string for inline tokenizing once every link definition is
// known. Returns the (initially empty) token array the pass will fill.
function queueInline(S, src) {
  const tokens = [];
  S.inlineQueue.push({ src, tokens });
  return tokens;
}

// ---------------------------------------------------------------------------
// Emphasis closer hints: one scan of a masked inline source finds the last
// run of each delimiter that could close a span, so openers with no closer
// ahead bail out without running the right-delimiter scan.
// ---------------------------------------------------------------------------

function scanClosers(src) {
  let star = -1, und = -1, del = -1;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < src.length && src[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') del = i;
      else if (ch === '*') star = i;
      else und = i;
    }
    i = j - 1;
  }
  return { masked: src, star, und, del };
}

function lastCloser(S, masked, delim) {
  const frame = S.hintStack[S.hintStack.length - 1];
  if (frame && frame.masked === masked) {
    return delim === '~' ? frame.del : delim === '*' ? frame.star : frame.und;
  }
  const fresh = scanClosers(masked);
  return delim === '~' ? fresh.del : delim === '*' ? fresh.star : fresh.und;
}

// Does this link text hold a link already? An image does not count: an
// image may hold a link, a link may not.
function linkInText(S, text) {
  if (!text.includes('[')) return false;
  for (const match of text.matchAll(INL_BLOCK_SKIP)) {
    if (INL_LINK.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of text.matchAll(INL_REFLINK_SEARCH)) {
    const m0 = match[0];
    const refStart = m0.lastIndexOf('[');
    if (m0.charAt(0) === '!' || !Object.hasOwn(S.links, normalizeLabel(m0.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && linkInText(S, m0.slice(1, refStart - 1))) continue;
    return true;
  }
  return false;
}

// Mask links, code spans, html and escapes so emphasis and strikethrough
// do not see delimiters inside them. Every mask keeps the length it
// replaces: emStrong lines maskedSrc up with src by slicing from the end.
function maskSrc(S, src) {
  let masked = src;
  if (S.links && src.includes('[')) {
    const maskReflink = (m0) => {
      const refStart = m0.lastIndexOf('[');
      if (!Object.hasOwn(S.links, normalizeLabel(m0.slice(refStart + 1, -1)))) return m0;
      // A candidate whose text already holds a link never becomes one, so
      // flattening the whole span would hide the emphasis that still
      // applies inside it. Mask the links it holds instead. Images are
      // exempt: their text is flattened into an alt attribute.
      if (refStart > 1 && m0.charAt(0) !== '!') {
        const text = m0.slice(1, refStart - 1);
        if (linkInText(S, text)) {
          return '[' + text.replace(INL_REFLINK_SEARCH, maskReflink)
            + '][' + 'a'.repeat(m0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(m0.length - 2) + ']';
    };
    masked = masked.replace(INL_REFLINK_SEARCH, maskReflink);
  }
  // Mask escaped punctuation. A backslash inside a code span is literal,
  // not an escape, so mask the backticks inside the span instead.
  masked = masked.replace(INL_ANY_PUNCT_OUTSIDE_CODE, (m0, code, punct) => {
    if (punct) return '+'.repeat(m0.length);
    if (code) return code + m0.slice(code.length, -code.length).replace(/`/g, '+') + code;
    return m0;
  });
  // Mask links, code spans and html tags wholesale.
  masked = masked.replace(INL_BLOCK_SKIP, (m0, _link, context) => {
    const offset = context ? context.length : 0;
    return m0.slice(0, offset) + '[' + 'a'.repeat(m0.length - offset - 2) + ']';
  });
  return masked;
}

// ---------------------------------------------------------------------------
// Block tokenizers
// ---------------------------------------------------------------------------

function tokSpace(S, src) {
  const cap = BLK_NEWLINE.exec(src);
  if (cap && cap[0].length > 0) return { type: 'space', raw: cap[0] };
}

function tokCode(S, src) {
  const cap = BLK_CODE.exec(src);
  if (!cap) return undefined;
  const raw = trimTrailingBlankLines(cap[0]);
  return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(CODE_REMOVE_INDENT, '') };
}

function indentCodeCompensation(raw, text) {
  const m = raw.match(INDENT_CODE_COMP);
  if (!m) return text;
  const indentToCode = m[1];
  return text.split('\n').map((node) => {
    const mi = node.match(BEGINNING_SPACE);
    if (!mi) return node;
    // Up to the fence's own indentation is removed from each line, so a
    // line indented less than the fence loses whatever indentation it has.
    return node.slice(Math.min(mi[0].length, indentToCode.length));
  }).join('\n');
}

function tokFences(S, src) {
  const cap = BLK_FENCES.exec(src);
  if (!cap) return undefined;
  return {
    type: 'code',
    raw: cap[0],
    lang: cap[2] ? cap[2].trim().replace(INL_ANY_PUNCT, '$1') : cap[2],
    text: indentCodeCompensation(cap[0], cap[3] || ''),
  };
}

function tokHeading(S, src) {
  const cap = BLK_HEADING.exec(src);
  if (!cap) return undefined;
  let text = cap[2].trim();
  // Remove trailing #s; CommonMark requires a space or tab before them.
  if (ENDING_HASH.test(text)) {
    const trimmed = rtrim(text, '#');
    if (!trimmed || ENDING_SPACE_TAB.test(trimmed)) text = trimmed.trim();
  }
  return { type: 'heading', raw: rtrim(cap[0], '\n'), depth: cap[1].length, text, tokens: queueInline(S, text) };
}

function tokHr(S, src) {
  const cap = BLK_HR.exec(src);
  if (!cap) return undefined;
  return { type: 'hr', raw: rtrim(cap[0], '\n') };
}

function tokHtml(S, src) {
  const cap = BLK_HTML.exec(src);
  if (!cap) return undefined;
  const raw = trimTrailingBlankLines(cap[0]);
  return {
    type: 'html', block: true, raw,
    pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style',
    text: raw,
  };
}

function tokDef(S, src) {
  const cap = BLK_DEF.exec(src);
  if (!cap) return undefined;
  // Outside angle brackets a destination holds only balanced parentheses.
  if (!START_ANGLE.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) return undefined;
  const tag = normalizeLabel(cap[1]);
  const href = cap[2] ? cap[2].replace(HREF_BRACKETS, '$1').replace(INL_ANY_PUNCT, '$1') : '';
  const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(INL_ANY_PUNCT, '$1') : cap[3];
  return { type: 'def', tag, raw: rtrim(cap[0], '\n'), href, title };
}

function tokTable(S, src) {
  const cap = BLK_TABLE.exec(src);
  if (!cap) return undefined;
  if (!TABLE_DELIM.test(cap[2])) return undefined; // otherwise a setext heading
  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(TABLE_ALIGN_CHARS, '').split('|');
  const rows = cap[3] && cap[3].trim() ? cap[3].replace(TABLE_ROW_BLANK, '').split('\n') : [];
  if (headers.length !== aligns.length) return undefined;
  const item = { type: 'table', raw: rtrim(cap[0], '\n'), header: [], align: [], rows: [] };
  for (const align of aligns) {
    if (TABLE_ALIGN_RIGHT.test(align)) item.align.push('right');
    else if (TABLE_ALIGN_CENTER.test(align)) item.align.push('center');
    else if (TABLE_ALIGN_LEFT.test(align)) item.align.push('left');
    else item.align.push(null);
  }
  for (let i = 0; i < headers.length; i++) {
    item.header.push({ text: headers[i], tokens: queueInline(S, headers[i]), header: true, align: item.align[i] });
  }
  for (const row of rows) {
    item.rows.push(splitCells(row, item.header.length).map((cell, i) => ({
      text: cell, tokens: queueInline(S, cell), header: false, align: item.align[i],
    })));
  }
  return item;
}

// A table needs a delimiter row as its second line, starting (after up
// to three spaces) with '|', ':' or '-'. Checking that first keeps the
// full table pattern — with its lookaheads — off ordinary paragraphs.
const TABLE_DELIM_GUARD = /^ {0,3}\|? *:?-+/;
function tokTableGuarded(S, src) {
  const nl = src.indexOf('\n');
  if (nl === -1) return undefined;
  const end = src.indexOf('\n', nl + 1);
  if (!TABLE_DELIM_GUARD.test(src.slice(nl + 1, end === -1 ? src.length : end))) {
    return undefined;
  }
  return tokTable(S, src);
}

// A setext heading needs an underline line before the next blank line.
// The full setext pattern backtracks through its first line, so this
// cheap scan keeps it off paragraphs that cannot be one.
const SETEXT_TAIL = /\n {0,3}(=+|-+)[ \t]*(?:\n|$)/;
const BLANK_LINE_SEARCH = /\n[ \t]*\n/;
function hasSetextAhead(src) {
  const blankAt = src.search(BLANK_LINE_SEARCH);
  const end = blankAt === -1 ? src.length : blankAt + 1;
  return SETEXT_TAIL.test(src.slice(0, end));
}

function tokLheading(S, src) {
  const cap = BLK_LHEADING_GFM.exec(src);
  if (!cap) return undefined;
  const text = cap[1].trim();
  return {
    type: 'heading', raw: rtrim(cap[0], '\n'),
    depth: cap[2].charAt(0) === '=' ? 1 : 2,
    text, tokens: queueInline(S, text),
  };
}

function tokParagraph(S, src) {
  const cap = BLK_PARAGRAPH.exec(src);
  if (!cap) return undefined;
  const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
  return { type: 'paragraph', raw: cap[0], text, tokens: queueInline(S, text) };
}

function tokText(S, src) {
  const cap = BLK_TEXT.exec(src);
  if (!cap) return undefined;
  return { type: 'text', raw: cap[0], text: cap[0], tokens: queueInline(S, cap[0]) };
}

function tokBlockquote(S, src) {
  const cap = BLK_BLOCKQUOTE.exec(src);
  if (!cap) return undefined;
  let lines = rtrim(cap[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];

  while (lines.length > 0) {
    let inQuote = false;
    const currentLines = [];
    let i;
    for (i = 0; i < lines.length; i++) {
      // Lines up to a continuation: marked lines, then lazy lines that
      // follow them, until a line that starts a new block.
      if (QUOTE_START.test(lines[i])) {
        currentLines.push(lines[i]);
        inQuote = true;
      } else if (!inQuote) {
        currentLines.push(lines[i]);
      } else {
        break;
      }
    }
    lines = lines.slice(i);

    const currentRaw = currentLines.join('\n');
    // A tab after the marker runs to the next tab stop, and the marker
    // only consumes one space of it. A lazy setext underline is padded so
    // it is not read as a heading.
    const currentText = currentRaw
      .replace(QUOTE_MARKER_WS, (_, marker, ws) => marker + expandTabs(ws, marker.length))
      .replace(QUOTE_SETEXT, '\n    $1')
      .replace(QUOTE_SETEXT2, '');
    raw = raw ? `${raw}\n${currentRaw}` : currentRaw;
    text = text ? `${text}\n${currentText}` : currentText;

    // Parse the quote's lines as top-level tokens, merging paragraphs if
    // this is a continuation.
    const savedTop = S.top;
    S.top = true;
    blockTokens(S, currentText, tokens, true);
    S.top = savedTop;

    if (lines.length === 0) break;
    const lastToken = tokens[tokens.length - 1];

    if (lastToken && (lastToken.type === 'code' || lastToken.type === 'heading'
      || lastToken.type === 'hr' || lastToken.type === 'html' || lastToken.type === 'table')) {
      // A continuation cannot follow a code block, heading, hr, html or table.
      break;
    } else if (lastToken && lastToken.type === 'blockquote') {
      // Include the continuation in the nested blockquote.
      const oldToken = lastToken;
      const continuation = lines.join('\n');
      const newText = oldToken.raw + '\n' + continuation.replace(QUOTE_SETEXT2, '');
      const newToken = tokBlockquote(S, newText);
      tokens[tokens.length - 1] = newToken;
      // Only include continuation lines the nested quote actually
      // consumed. Unconsumed trailing lines stay out of `raw` so the
      // lexer can still tokenize them.
      const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) raw = `${raw}\n${consumed.join('\n')}`;
      text = text.substring(0, text.length - oldToken.text.length) + newToken.text;
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && QUOTE_START.test(lines[0])) continue;
      break;
    } else if (lastToken && lastToken.type === 'list') {
      // Include the continuation in the nested list.
      const oldToken = lastToken;
      const newText = oldToken.raw + '\n' + lines.join('\n');
      const newToken = tokList(S, newText);
      tokens[tokens.length - 1] = newToken;
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

  return { type: 'blockquote', raw, tokens, text };
}

// First line of a string, without allocating a split array.
function headLine(s) {
  const nl = s.indexOf('\n');
  return nl === -1 ? s : s.slice(0, nl);
}

function tokList(S, src) {
  const cap0 = BLK_LIST.exec(src);
  if (!cap0) return undefined;
  // src is only consumed from the front, so every raw below is a slice of
  // listSrc rather than a string built up line by line.
  const listSrc = src;
  let srcCur = src;
  const taken = () => listSrc.length - srcCur.length;
  let bull = cap0[1].trim();
  const isOrdered = bull.length > 1;

  const list = {
    type: 'list', raw: '', ordered: isOrdered,
    start: isOrdered ? +bull.slice(0, -1) : '',
    loose: false, items: [],
  };
  bull = isOrdered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;

  const itemRe = listItemRe(bull);
  let endsWithBlankLine = false;

  while (srcCur) {
    let endEarly = false;
    let itemContents = '';
    let cap = itemRe.exec(srcCur);
    if (!cap) break;
    if (BLK_HR.test(srcCur)) break; // the bullet was actually an hr

    const itemStart = taken();
    srcCur = srcCur.substring(cap[0].length);

    const firstLine = headLine(cap[2]);
    const bulletIndent = cap[1].length;
    // Only expand leading whitespace when there is some; the common
    // case has none and the replace would only allocate a closure.
    let line = (firstLine[0] === ' ' || firstLine[0] === '\t')
      ? firstLine.replace(LEADING_SPACE_TAB, (ws) => expandTabs(ws, bulletIndent))
      : firstLine;
    let nextLine = headLine(srcCur);
    let blankLine = !line.trim();

    let indent = 0;
    if (blankLine) {
      indent = bulletIndent + 1;
    } else {
      indent = line.search(NON_SPACE); // first non-space character
      indent = indent > 4 ? 1 : indent; // >4 spaces is indented code, count as 1
      itemContents = line.slice(indent);
      indent += bulletIndent;
    }

    // Items begin with at most one blank line.
    if (blankLine && BLANK_LINE.test(nextLine)) {
      srcCur = srcCur.substring(nextLine.length + 1);
      endEarly = true;
    }

    if (!endEarly) {
      const nextBulletRe = NEXT_BULLET_RE(indent);
      const hrRe = HR_AT_RE(indent);
      const fencesRe = FENCES_AT_RE(indent);
      const headingRe = HEADING_AT_RE(indent);
      const htmlRe = HTML_AT_RE(indent);
      const quoteRe = QUOTE_AT_RE(indent);

      while (srcCur) {
        const rawLine = headLine(srcCur);
        nextLine = rawLine;
        // Re-align to follow CommonMark nesting rules.
        const nextLineNoTabs = (nextLine[0] === ' ' || nextLine[0] === '\t')
          ? nextLine.replace(LEADING_SPACE_TAB, (ws) => expandTabs(ws))
          : nextLine;

        if (fencesRe.test(nextLine)) break;
        if (headingRe.test(nextLine)) break;
        if (htmlRe.test(nextLine)) break;
        if (quoteRe.test(nextLine)) break;
        if (nextBulletRe.test(nextLine)) break;
        if (hrRe.test(nextLine)) break;

        if (nextLineNoTabs.search(NON_SPACE) >= indent || !nextLine.trim()) {
          itemContents += '\n' + nextLineNoTabs.slice(indent);
        } else {
          // Not enough indentation.
          if (blankLine) break;
          // Paragraph continuation unless the last line was a different
          // block-level element.
          if (line.includes('\t')
            ? line.replace(TAB_GLOBAL, '    ').search(NON_SPACE) >= 4
            : line.search(NON_SPACE) >= 4) break;
          if (fencesRe.test(line)) break;
          if (headingRe.test(line)) break;
          if (htmlRe.test(line)) break;
          if (hrRe.test(line)) break;
          // A lazy continuation can look like a setext underline after
          // list indentation is removed. Keep it in the paragraph.
          const setextContinuation = SETEXT_LINE.test(nextLine)
            && BLK_LHEADING_GFM.test(`${line}\n${nextLine}`);
          const continuation = setextContinuation
            ? `    ${nextLineNoTabs.replace(/^ {0,3}/, '')}`
            : nextLine;
          itemContents += '\n' + continuation;
        }

        blankLine = !nextLine.trim();
        srcCur = srcCur.substring(rawLine.length + 1);
        line = nextLineNoTabs.slice(indent);
      }
    }

    const raw = listSrc.slice(itemStart, taken());

    if (!list.loose) {
      if (endsWithBlankLine) list.loose = true;
      else if (DOUBLE_BLANK.test(raw)) endsWithBlankLine = true;
    }

    list.items.push({
      type: 'list_item', raw,
      task: LIST_IS_TASK.test(itemContents),
      loose: false, text: itemContents, tokens: [],
    });
  }

  const lastItem = list.items[list.items.length - 1];
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else {
    return undefined; // not a list since there were no items
  }
  list.raw = listSrc.slice(0, taken()).trimEnd();

  // Item child tokens are handled here because the final item had to be
  // trimmed first. First pass: tokenize items and finalize list.loose
  // from spacers, before placing checkboxes.
  for (const item of list.items) {
    S.top = false;
    item.tokens = blockTokens(S, item.text, []);
    if (!list.loose) {
      const spacers = item.tokens.filter((t) => t.type === 'space');
      const hasMultipleLineBreaks = spacers.length > 0
        && spacers.some((t) => ANY_LINE.test(t.raw));
      list.loose = hasMultipleLineBreaks;
    }
  }

  // Second pass: place task checkboxes using the final list.loose.
  for (const item of list.items) {
    const itemToken = item.tokens[0];
    if (item.task && (itemToken && (itemToken.type === 'text' || itemToken.type === 'paragraph'))) {
      item.text = item.text.replace(LIST_TASK, '');
      itemToken.raw = itemToken.raw.replace(LIST_TASK, '');
      itemToken.text = itemToken.text.replace(LIST_TASK, '');
      for (let i = S.inlineQueue.length - 1; i >= 0; i--) {
        if (LIST_IS_TASK.test(S.inlineQueue[i].src)) {
          S.inlineQueue[i].src = S.inlineQueue[i].src.replace(LIST_TASK, '');
          break;
        }
      }
      const taskRaw = LIST_TASK_BOX.exec(item.raw);
      if (taskRaw) {
        const checkboxToken = {
          type: 'checkbox', raw: taskRaw[0] + ' ', checked: taskRaw[0] !== '[ ]',
        };
        item.checked = checkboxToken.checked;
        if (list.loose) {
          if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) && item.tokens[0].tokens) {
            item.tokens[0].raw = checkboxToken.raw + item.tokens[0].raw;
            item.tokens[0].text = checkboxToken.raw + item.tokens[0].text;
            item.tokens[0].tokens.unshift(checkboxToken);
          } else {
            item.tokens.unshift({
              type: 'paragraph', raw: checkboxToken.raw, text: checkboxToken.raw,
              tokens: [checkboxToken],
            });
          }
        } else {
          item.tokens.unshift(checkboxToken);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }

  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const token of item.tokens) {
        if (token.type === 'text') token.type = 'paragraph';
      }
    }
  }

  return list;
}

// ---------------------------------------------------------------------------
// Block lexing loop
// ---------------------------------------------------------------------------

function blockTokens(S, src, tokens = [], lastParagraphClipped = false) {
  let srcLength = Infinity;
  while (src) {
    if (src.length < srcLength) {
      srcLength = src.length;
    } else {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }

    let token;
    // First characters, used as cheap necessary-condition guards so the
    // expensive block patterns are only tried where they can match. `c`
    // is the first character after up to three leading spaces; most
    // block patterns allow at most three.
    const c0 = src[0];
    let sp = 0;
    while (sp < 3 && src[sp] === ' ') sp++;
    const c = src[sp];

    // Blank lines.
    if ((c0 === ' ' || c0 === '\t' || c0 === '\n') && (token = tokSpace(S, src))) {
      src = src.substring(token.raw.length);
      const lastToken = tokens[tokens.length - 1];
      if (token.raw.length === 1 && lastToken !== undefined) {
        // A single \n as a spacer terminates the last line, so move it
        // there instead of leaving an unnecessary paragraph break.
        lastToken.raw += '\n';
      } else {
        tokens.push(token);
      }
      continue;
    }

    // Indented code. It cannot interrupt a paragraph: the lines join it.
    if ((c0 === ' ' || c0 === '\t') && (token = tokCode(S, src))) {
      src = src.substring(token.raw.length);
      const lastToken = tokens[tokens.length - 1];
      if (lastToken && (lastToken.type === 'paragraph' || lastToken.type === 'text')) {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        S.inlineQueue[S.inlineQueue.length - 1].src = lastToken.text;
      } else {
        tokens.push(token);
      }
      continue;
    }

    if ((c === '`' || c === '~') && (token = tokFences(S, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    if (c === '#' && (token = tokHeading(S, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    if ((c === '-' || c === '_' || c === '*') && (token = tokHr(S, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    if (c === '>' && (token = tokBlockquote(S, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    if ((c === '*' || c === '+' || c === '-' || (c >= '0' && c <= '9'))
      && (token = tokList(S, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    if (c === '<' && (token = tokHtml(S, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // Link reference definition. Inside a paragraph it is absorbed into
    // the paragraph text; otherwise the first definition of a label wins,
    // but a later one still consumes its text.
    if (c === '[' && (token = tokDef(S, src))) {
      src = src.substring(token.raw.length);
      const lastToken = tokens[tokens.length - 1];
      if (lastToken && (lastToken.type === 'paragraph' || lastToken.type === 'text')) {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.raw;
        S.inlineQueue[S.inlineQueue.length - 1].src = lastToken.text;
      } else {
        if (!S.links[token.tag]) {
          S.links[token.tag] = { href: token.href, title: token.title };
        }
        tokens.push(token);
      }
      continue;
    }

    if ((token = tokTableGuarded(S, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    if (hasSetextAhead(src) && (token = tokLheading(S, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // Top-level paragraph.
    if (S.top && (token = tokParagraph(S, src))) {
      const lastToken = tokens[tokens.length - 1];
      if (lastParagraphClipped && lastToken && lastToken.type === 'paragraph') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        S.inlineQueue.pop();
        S.inlineQueue[S.inlineQueue.length - 1].src = lastToken.text;
      } else {
        tokens.push(token);
      }
      src = src.substring(token.raw.length);
      continue;
    }

    // Loose text (inside list items and blockquotes, where top is false).
    if ((token = tokText(S, src))) {
      src = src.substring(token.raw.length);
      const lastToken = tokens[tokens.length - 1];
      if (lastToken && lastToken.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        S.inlineQueue.pop();
        S.inlineQueue[S.inlineQueue.length - 1].src = lastToken.text;
      } else {
        tokens.push(token);
      }
      continue;
    }

    if (src) {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
  }

  S.top = true;
  return tokens;
}

// ---------------------------------------------------------------------------
// Inline tokenizers
// ---------------------------------------------------------------------------

function tokEscape(S, src) {
  const cap = INL_ESCAPE.exec(src);
  if (!cap) return undefined;
  return { type: 'escape', raw: cap[0], text: cap[1] };
}

function tokTag(S, src) {
  const cap = INL_TAG.exec(src);
  if (!cap) return undefined;
  if (!S.inLink && START_A_TAG.test(cap[0])) S.inLink = true;
  else if (S.inLink && END_A_TAG.test(cap[0])) S.inLink = false;
  if (!S.inRawBlock && START_PRE_TAG.test(cap[0])) S.inRawBlock = true;
  else if (S.inRawBlock && END_PRE_TAG.test(cap[0])) S.inRawBlock = false;
  return {
    type: 'html', raw: cap[0],
    inLink: S.inLink, inRawBlock: S.inRawBlock, block: false, text: cap[0],
  };
}

// Build a link or image token from a matched label and destination. The
// label text is tokenized inline; a link whose label already holds a link
// is rejected (CommonMark: links may not contain other links), so the
// caller falls through to plain text and the inner link is the one kept.
function outputLink(S, cap, link, raw) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(OUTPUT_LINK_REPLACE, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const outerInLink = S.inLink;
  const outerLinkEmitted = S.linkEmitted;
  const outerInRawBlock = S.inRawBlock;
  S.inLink = true;
  S.linkEmitted = false;
  const tokens = inlineTokens(S, text);
  const textHasLink = S.linkEmitted;
  S.linkEmitted = outerLinkEmitted;
  S.inLink = outerInLink;
  if (!isImage) {
    if (textHasLink) {
      // These tokens are discarded, so undo the raw-block state they
      // opened; leaving it set would suppress escaping for the text that
      // is re-scanned.
      S.inRawBlock = outerInRawBlock;
      return undefined;
    }
    S.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
}

// Is the end of this label actually inside an inline tag or autolink that
// runs past it? Then the label is not a label at all.
function isLabelEndInsideToken(S, src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const code = INL_CODE.exec(label.slice(i));
      if (code) { i += code[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = INL_TAG.exec(tokenSrc) || INL_AUTOLINK.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

function tokLink(S, src) {
  // The link pattern backtracks quadratically over unterminated-link
  // inputs. inlineTokens anchors one paren scan per run in
  // linkParenPossible; without a ')' ahead the pattern cannot match, so
  // bail out before running it.
  if (S.linkParenPossible === false) return undefined;
  const cap = INL_LINK.exec(src);
  if (!cap) return undefined;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(S, src, cap[1], labelStart)) return undefined;

  const trimmedUrl = cap[2].trim();
  if (START_ANGLE.test(trimmedUrl)) {
    // CommonMark requires matching angle brackets.
    if (!END_ANGLE.test(trimmedUrl)) return undefined;
    // The ending angle bracket cannot be escaped.
    const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return undefined;
  } else {
    // Find the closing parenthesis.
    const lastParenIndex = findClosingBracket(cap[2], '()');
    if (lastParenIndex === -2) return undefined; // more opens than closes
    if (lastParenIndex > -1) {
      const start = cap[0].indexOf('!') === 0 ? 5 : 4;
      const linkLen = start + cap[1].length + lastParenIndex;
      cap[2] = cap[2].substring(0, lastParenIndex);
      cap[0] = cap[0].substring(0, linkLen).trim();
      cap[3] = '';
    }
  }
  // The ')' that ends the match is the link closer only when it is not
  // escaped. `[foo](/url\)` has no closer; that paren is destination text.
  const unescaped = rtrim(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - unescaped.length) % 2 === 0) return undefined;

  let href = cap[2];
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  href = href.trim();
  if (START_ANGLE.test(href)) href = href.slice(1, -1);
  return outputLink(S, cap, {
    href: href ? href.replace(INL_ANY_PUNCT, '$1') : href,
    title: title ? title.replace(INL_ANY_PUNCT, '$1') : title,
  }, cap[0]);
}

function tokReflink(S, src) {
  const cap = INL_REFLINK.exec(src) || INL_NOLINK.exec(src);
  if (!cap) return undefined;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(S, src, cap[1], labelStart)) return undefined;
  const link = S.links[normalizeLabel(cap[2] || cap[1])];
  if (!link) {
    // Not a reference: only the opening bracket is literal text.
    const text = cap[0].charAt(0);
    return { type: 'text', raw: text, text };
  }
  return outputLink(S, cap, link, cap[0]);
}

function tokEmStrong(S, src, maskedSrc, prevChar = '') {
  let match = INL_EM_L_DELIM.exec(src);
  if (!match) return undefined;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return undefined;

  const delimChar = match[0][0];
  // A mid-run opener (for example the second star of an unmatched `**`)
  // must only pair with a delimiter that can only close, otherwise it
  // steals the opener of a later span.
  const midRun = prevChar === delimChar;

  // The start of this delimiter run may already be behind src, either
  // taken as text after the whole run failed to match or used to close an
  // earlier span. Flanking and rules 9-10 are about the whole run, so
  // find its start.
  const srcStart = maskedSrc.length - src.length;
  let runStart = srcStart;
  while (runStart > 0 && maskedSrc[runStart - 1] === delimChar) runStart--;
  const runPrevChar = [...maskedSrc.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  // The other delimiter character counts as punctuation here (`_**a*`).
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_'
    || !!INL_PUNCT.exec(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : !!INL_PUNCT.exec(prevChar);

  // _ can't be between two alphanumerics.
  if (match[4] && prevChar.match(UNICODE_ALNUM)) return undefined;

  const nextChar = match[1] || match[3] || '';

  if (!nextChar || !prevChar || prevPunct) {
    // Spread into code points: the regex counts emoji as one character.
    const lLength = [...match[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;

    // Rules 9-10 count the whole run, and also apply when the opener
    // could close as well (`a*b**`, where `*` is both left- and
    // right-flanking).
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim()
      && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return undefined;
    const endReg = delimChar === '*' ? INL_EM_R_DELIM_AST : INL_EM_R_DELIM_UND;
    const lastCloserIdx = lastCloser(S, maskedSrc, delimChar);
    const windowStart = maskedSrc.length - src.length + lLength;
    if (lastCloserIdx < windowStart) return undefined;
    // Clip maskedSrc to the same section of string as src.
    maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
    const lastCloserInWindow = lastCloserIdx - windowStart;
    endReg.lastIndex = 0;

    while ((match = endReg.exec(maskedSrc)) !== null) {
      if (match.index > lastCloserInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue; // skip single * in __abc*abc__
      rLength = [...rDelim].length;

      if (match[3] || match[4]) { // found another left delimiter
        delimTotal += rLength;
        continue;
      } else if (match[5] || match[6] || openerCanClose) { // either side
        if (midRun && (match[5] || match[6])) {
          // A mid-run opener cannot close against an ambiguous delimiter
          // that can also open; that delimiter opens its own span instead.
          break;
        }
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue; // CommonMark emphasis rules 9-10
        }
      }

      delimTotal -= rLength;
      if (delimTotal > 0) continue; // not enough closing delimiters yet

      // Remove extra characters. *a*** -> *a*
      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);

      // Odd smallest delimiter count makes emphasis, even makes strong.
      if (Math.min(lLength, rLength) % 2) {
        const text = raw.slice(1, -1);
        return { type: 'em', raw, text, tokens: inlineTokens(S, text) };
      }
      const text = raw.slice(2, -2);
      return { type: 'strong', raw, text, tokens: inlineTokens(S, text) };
    }
  }
}

function tokCodespan(S, src) {
  const cap = INL_CODE.exec(src);
  if (!cap) return undefined;
  let text = cap[2].replace(NEWLINE_GLOBAL, ' ');
  const hasNonSpaceChars = NON_SPACE.test(text);
  const hasSpaceCharsOnBothEnds = text.charAt(0) === ' ' && text.charAt(text.length - 1) === ' ';
  if (hasNonSpaceChars && hasSpaceCharsOnBothEnds) {
    text = text.substring(1, text.length - 1);
  }
  return { type: 'codespan', raw: cap[0], text };
}

function tokBr(S, src) {
  const cap = INL_BR.exec(src);
  if (!cap) return undefined;
  return { type: 'br', raw: cap[0] };
}

function tokDel(S, src, maskedSrc, prevChar = '') {
  let match = INL_DEL_L_DELIM.exec(src);
  if (!match) return undefined;
  const nextChar = match[1] || '';

  if (!nextChar || !prevChar || INL_PUNCT.exec(prevChar)) {
    const lLength = [...match[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength;
    const endReg = INL_DEL_R_DELIM;
    const lastDelIdx = lastCloser(S, maskedSrc, '~');
    const windowStart = maskedSrc.length - src.length + lLength;
    if (lastDelIdx < windowStart) return undefined;
    maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
    const lastDelInWindow = lastDelIdx - windowStart;
    endReg.lastIndex = 0;

    while ((match = endReg.exec(maskedSrc)) !== null) {
      if (match.index > lastDelInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;
      if (rLength !== lLength) continue;
      if (match[3] || match[4]) { // found another left delimiter
        delimTotal += rLength;
        continue;
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);
      const text = raw.slice(lLength, -lLength);
      return { type: 'del', raw, text, tokens: inlineTokens(S, text) };
    }
  }
}

function tokAutolink(S, src) {
  const cap = INL_AUTOLINK.exec(src);
  if (!cap) return undefined;
  let text, href;
  if (cap[2] === '@') {
    text = cap[1];
    href = 'mailto:' + text;
  } else {
    text = cap[1];
    href = text;
  }
  return {
    type: 'link', raw: cap[0], text, href, autolink: true,
    tokens: [{ type: 'text', raw: text, text }],
  };
}

function tokUrl(S, src) {
  const cap = INL_URL.exec(src);
  if (!cap) return undefined;
  let text, href;
  if (cap[2] === '@') {
    text = cap[0];
    href = 'mailto:' + text;
  } else {
    // Backpedal over trailing punctuation the autolink must not include.
    let prevCapZero;
    do {
      prevCapZero = cap[0];
      cap[0] = INL_BACKPEDAL.exec(cap[0])?.[0] ?? '';
    } while (prevCapZero !== cap[0]);
    text = cap[0];
    href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
  }
  return {
    type: 'link', raw: cap[0], text, href, autolink: true,
    tokens: [{ type: 'text', raw: text, text }],
  };
}

function tokInlineText(S, src) {
  const cap = INL_TEXT.exec(src);
  if (!cap) return undefined;
  const escaped = S.inRawBlock;
  return {
    type: 'text', raw: cap[0],
    // Raw HTML keeps whatever it was written with; everywhere else a
    // numeric character reference stands for the character itself.
    text: escaped ? cap[0] : decodeNumericRefs(cap[0]),
    escaped,
  };
}

// ---------------------------------------------------------------------------
// Inline lexing loop
// ---------------------------------------------------------------------------

function inlineTokens(S, src, tokens = []) {
  // One paren scan per inline run, shared with tokLink: without a ')'
  // ahead the link pattern cannot match, and skipping it avoids its
  // quadratic backtracking over unterminated-link inputs. A nested run
  // receives a substring of the outer run, so if the outer had no ')'
  // neither does this substring — skip the scan in that case.
  const prevLinkParenPossible = S.linkParenPossible;
  S.linkParenPossible = prevLinkParenPossible && src.includes(')');
  try {
    return inlineTokensInner(S, src, tokens);
  } finally {
    // A nested run anchored on its own substring; restore the outer run's
    // flag for the rest of its loop.
    S.linkParenPossible = prevLinkParenPossible;
  }
}

function inlineTokensInner(S, src, tokens) {
  // The masked source is only read by emphasis and strikethrough, which
  // need a *, _ or ~ to start. Skip building it for a run without one,
  // and skip the masking passes when the run holds no '[', backslash,
  // backtick or '<' for them to act on.
  const hasDelim = src.includes('*') || src.includes('_') || src.includes('~');
  const maskedSrc = hasDelim && /[\[\\`<]/.test(src) ? maskSrc(S, src) : src;
  // One scan of this maskedSrc for the last emphasis, strong, and
  // strikethrough closers, shared by every opener in the pass. Popped
  // when the pass ends so the source is not retained.
  if (hasDelim) S.hintStack.push(scanClosers(maskedSrc));
  try {
    return tokenizeInlines(S, src, maskedSrc, tokens);
  } finally {
    if (hasDelim) S.hintStack.pop();
  }
}

function tokenizeInlines(S, src, maskedSrc, tokens) {
  // Per-run presence flags, computed once: which tokenizers can possibly
  // fire anywhere in this run. A flag is a necessary condition, so a
  // missing one skips that tokenizer for the whole run.
  const hasBs = src.includes('\\');
  const hasLt = src.includes('<');
  const hasUrl = src.includes('@') || src.includes('://') || src.includes('www.');
  let keepPrevChar = false;
  let prevChar = '';
  let srcLength = Infinity;
  while (src) {
    if (src.length < srcLength) {
      srcLength = src.length;
    } else {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }

    if (!keepPrevChar) prevChar = '';
    keepPrevChar = false;

    let token;
    const ch = src[0];

    // Dispatch on the first character: only the tokenizers that can
    // start with it are tried, in marked's order. Anything else falls
    // through to plain text.
    if (ch === '\\') {
      if (hasBs && (token = tokEscape(S, src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if ((token = tokBr(S, src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    } else if (ch === '<') {
      if (hasLt && (token = tokTag(S, src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (hasLt && (token = tokAutolink(S, src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    } else if (ch === '[' || ch === '!') {
      if ((token = tokLink(S, src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if ((token = tokReflink(S, src))) {
        src = src.substring(token.raw.length);
        const lastToken = tokens[tokens.length - 1];
        if (token.type === 'text' && lastToken && lastToken.type === 'text') {
          lastToken.raw += token.raw;
          lastToken.text += token.text;
        } else {
          tokens.push(token);
        }
        continue;
      }
    } else if (ch === '*' || ch === '_') {
      if ((token = tokEmStrong(S, src, maskedSrc, prevChar))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      // '_' can also start an email autolink (`_a@b.com`); '*' cannot.
      if (ch === '_' && hasUrl && !S.inLink && (token = tokUrl(S, src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    } else if (ch === '`') {
      if ((token = tokCodespan(S, src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    } else if (ch === '~') {
      if ((token = tokDel(S, src, maskedSrc, prevChar))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    } else if (ch === ' ') {
      if ((token = tokBr(S, src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    } else if (hasUrl && !S.inLink
      && ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')
        || (ch >= '0' && ch <= '9') || ch === '.' || ch === '_' || ch === '+' || ch === '-')
      && (token = tokUrl(S, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    if ((token = tokInlineText(S, src))) {
      src = src.substring(token.raw.length);
      // Track prevChar before a run of ____ started.
      if (token.raw.slice(-1) !== '_') prevChar = token.raw.slice(-1);
      keepPrevChar = true;
      const lastToken = tokens[tokens.length - 1];
      if (lastToken && lastToken.type === 'text') {
        lastToken.raw += token.raw;
        lastToken.text += token.text;
      } else {
        tokens.push(token);
      }
      continue;
    }

    if (src) {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// Render inline tokens. In text mode (image alt text) only the textual
// part is returned: no tags, no escaping, no line breaks.
function renderInline(tokens, textMode = false) {
  let out = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'escape': {
        out += textMode ? token.text : escHtml(token.text);
        break;
      }
      case 'html': {
        out += token.text;
        break;
      }
      case 'link': {
        if (textMode) {
          out += renderInline(token.tokens, true);
        } else {
          // References are not resolved inside an autolink, so every `&`
          // there is literal. Elsewhere only an `&` that cannot start a
          // reference needs escaping.
          const parsedText = token.autolink
            ? escHtml(token.text, true)
            : renderInline(token.tokens);
          const cleanHref = cleanUrl(token.href);
          if (cleanHref === null) {
            out += parsedText;
          } else {
            let linkOut = '<a href="' + escHtml(cleanHref, token.autolink) + '"';
            if (token.title) linkOut += ' title="' + escHtml(token.title) + '"';
            linkOut += '>' + parsedText + '</a>';
            out += linkOut;
          }
        }
        break;
      }
      case 'image': {
        if (textMode) {
          out += renderInline(token.tokens, true);
        } else {
          let text = token.text;
          if (token.tokens) text = renderInline(token.tokens, true);
          const cleanHref = cleanUrl(token.href);
          if (cleanHref === null) {
            out += escHtml(text);
          } else {
            let imgOut = `<img src="${escHtml(cleanHref)}" alt="${escHtml(text)}"`;
            if (token.title) imgOut += ` title="${escHtml(token.title)}"`;
            imgOut += '>';
            out += imgOut;
          }
        }
        break;
      }
      case 'checkbox': {
        out += textMode ? token.raw
          : '<input ' + (token.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        break;
      }
      case 'strong': {
        out += textMode
          ? renderInline(token.tokens, true)
          : `<strong>${renderInline(token.tokens)}</strong>`;
        break;
      }
      case 'em': {
        out += textMode
          ? renderInline(token.tokens, true)
          : `<em>${renderInline(token.tokens)}</em>`;
        break;
      }
      case 'codespan': {
        out += textMode ? token.text : `<code>${escHtml(token.text, true)}</code>`;
        break;
      }
      case 'br': {
        out += textMode ? '' : '<br>';
        break;
      }
      case 'del': {
        out += textMode
          ? renderInline(token.tokens, true)
          : `<del>${renderInline(token.tokens)}</del>`;
        break;
      }
      case 'text': {
        if (token.tokens) {
          out += textMode ? token.text : renderInline(token.tokens);
        } else if (token.escaped) {
          out += token.text;
        } else {
          out += textMode ? token.text : escHtml(token.text);
        }
        break;
      }
      default: {
        throw new Error('Token with "' + token.type + '" type was not found.');
      }
    }
  }
  return out;
}

function renderTokens(tokens) {
  let out = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'space': {
        break;
      }
      case 'hr': {
        out += '<hr>\n';
        break;
      }
      case 'heading': {
        out += `<h${token.depth}>${renderInline(token.tokens)}</h${token.depth}>\n`;
        break;
      }
      case 'code': {
        const langString = (token.lang || '').match(NOT_SPACE_START)?.[0];
        // An empty code block has no content, so it must not gain a newline.
        const code = token.text ? token.text.replace(ENDING_NEWLINE, '') + '\n' : '';
        if (!langString) {
          out += '<pre><code>' + escHtml(code, true) + '</code></pre>\n';
        } else {
          out += '<pre><code class="language-' + escHtml(langString) + '">'
            + escHtml(code, true) + '</code></pre>\n';
        }
        break;
      }
      case 'table': {
        let header = '';
        for (const cell of token.header) {
          const content = renderInline(cell.tokens);
          const tag = cell.align ? `<th align="${cell.align}">` : '<th>';
          header += tag + content + '</th>\n';
        }
        let body = '';
        for (const row of token.rows) {
          let cellHtml = '';
          for (const cell of row) {
            const content = renderInline(cell.tokens);
            const tag = cell.align ? `<td align="${cell.align}">` : '<td>';
            cellHtml += tag + content + '</td>\n';
          }
          body += `<tr>\n${cellHtml}</tr>\n`;
        }
        if (body) body = `<tbody>${body}</tbody>`;
        out += '<table>\n<thead>\n' + `<tr>\n${header}</tr>\n` + '</thead>\n' + body + '</table>\n';
        break;
      }
      case 'blockquote': {
        out += `<blockquote>\n${renderTokens(token.tokens)}</blockquote>\n`;
        break;
      }
      case 'list': {
        let body = '';
        for (const item of token.items) {
          body += `<li>${renderTokens(item.tokens)}</li>\n`;
        }
        const type = token.ordered ? 'ol' : 'ul';
        const startAttr = (token.ordered && token.start !== 1)
          ? (' start="' + token.start + '"')
          : '';
        out += '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
        break;
      }
      case 'checkbox': {
        out += '<input ' + (token.checked ? 'checked="" ' : '')
          + 'disabled="" type="checkbox"> ';
        break;
      }
      case 'html': {
        out += token.text;
        break;
      }
      case 'def': {
        break;
      }
      case 'paragraph': {
        out += `<p>${renderInline(token.tokens)}</p>\n`;
        break;
      }
      case 'text': {
        out += renderInline(token.tokens);
        break;
      }
      default: {
        throw new Error('Token with "' + token.type + '" type was not found.');
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function lex(src) {
  const S = newState();
  src = src.replace(/\r\n|\r/g, '\n');
  const tokens = blockTokens(S, src, []);
  for (const next of S.inlineQueue) {
    // An inline <pre>, <code>, <kbd> or <script> left open ends with the
    // block holding it; carried over, it would stop every later block's
    // text from being escaped.
    S.inRawBlock = false;
    inlineTokens(S, next.src, next.tokens);
  }
  S.inlineQueue = [];
  return tokens;
}

/** The HTML marked 18.1.3 renders for `markdown`, with its defaults. */
export function parse(markdown) {
  if (typeof markdown !== 'string') {
    throw new Error('parse(): input parameter is of type '
      + Object.prototype.toString.call(markdown) + ', string expected');
  }
  return renderTokens(lex(markdown));
}
