// The commands as the CLI sees them: one name each, wired to the boundaries through their index files.
import { approve } from './approve.ts';
import { doctor } from './doctor.ts';
import { estimate } from './estimate.ts';
import { finish } from './finish.ts';
import { generate } from './generate.ts';
import { make } from './make.ts';
import { newWork } from './new.ts';
import { preview } from './preview.ts';
import { price } from './price.ts';
import { priceCheck } from './price-check.ts';
import { resolve } from './resolve.ts';
import type { Command } from './shared.ts';
import { sheet } from './sheet.ts';
import { smoke } from './smoke.ts';
import { speech } from './speech.ts';
import { status } from './status.ts';

export { type AppCtx, type Command, keyStoreOf } from './shared.ts';

export const COMMANDS: Readonly<Record<string, Command>> = {
  new: newWork,
  preview,
  estimate,
  approve,
  generate,
  status,
  resolve,
  make,
  sheet,
  finish,
  smoke,
  speech,
  price,
  'price-check': priceCheck,
  doctor,
};
