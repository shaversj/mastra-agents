import { writeFile } from 'node:fs/promises';

await writeFile('generated.txt', 'prepared\n');
