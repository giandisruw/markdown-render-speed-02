// Driver for this markdown-render-speed entry.
//
// It loads the case list, renders every markdown document on its own
// through the parse routine in parse.js, and stores the resulting HTML
// strings, in the same order as the cases, as one JSON array.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputFolder = process.env.MAKEFUN_INPUT_DIR || '/input';
const outputFolder = process.env.MAKEFUN_OUTPUT_DIR || '/output';

const caseText = readFileSync(join(inputFolder, 'cases.json'), 'utf8');
const caseList = JSON.parse(caseText);

const renderedHtml = caseList.map((entry) => parse(entry.markdown));

mkdirSync(outputFolder, { recursive: true });
writeFileSync(join(outputFolder, 'html.json'), JSON.stringify(renderedHtml));
