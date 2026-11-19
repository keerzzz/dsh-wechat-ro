// Client-face typert contribution for the ./remote export.
//
// The browser bundle (lib/client.js) is standalone lazy-CJS and carries its own
// inline copy of this list; this module exists so the contract is also
// importable and checkable from Node, and so a future build step can feed it to
// ctx.remote.$mount unchanged.

import { z } from 'zod';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';
import { METHOD_SPECS, NAMESPACE, PACKAGE_NAME, REQUEST_WIRE, SIGNAL_WIRE, requestSchemaFor, resultSchemaFor } from './wire.js';
import { CONVERSATION_METHOD_SPECS, CONVERSATION_NAMESPACE, conversationDescriptorFor } from './conversation-wire.js';

function codec(typeSymbol, spec) {
  return { mode: 'strict', typeSymbol, create: () => requestSchemaFor(spec), description: 'Validated method request.' };
}

const methods = {};
for (const spec of METHOD_SPECS) {
  methods[NAMESPACE + '/' + spec.method] = {
    service: NAMESPACE,
    description: spec.description,
    invocation: { kind: 'direct' },
    parameters: [
      {
        name: REQUEST_WIRE,
        wire: REQUEST_WIRE,
        source: 'json',
        acceptsUndefined: true,
        description: 'Optional request object.',
        codec: codec(PACKAGE_NAME + '#' + spec.method + 'Request', spec),
        strictCodec: codec(PACKAGE_NAME + '#' + spec.method + 'Request', spec),
      },
    ],
    cancellation: { parameter: SIGNAL_WIRE },
    result: {
      mode: 'strict',
      typeSymbol: PACKAGE_NAME + '#' + spec.method + 'Result',
      create: () => resultSchemaFor(spec),
      description: 'Method result payload.',
    },
  };
}

for (const spec of CONVERSATION_METHOD_SPECS) {
  const descriptor = conversationDescriptorFor(spec);
  methods[CONVERSATION_NAMESPACE + '/' + spec.method] = {
    service: CONVERSATION_NAMESPACE, description: spec.description, invocation: descriptor.invocation,
    parameters: descriptor.parameters, cancellation: descriptor.cancellation, result: descriptor.result,
  };
}
export const TYPERT_REMOTE = createTypertRemoteInfo({ package: PACKAGE_NAME, methods }, z);

export default TYPERT_REMOTE;
