import { Contract, Address, nativeToScVal, scValToNative, TransactionBuilder, Account, Networks } from '@stellar/stellar-sdk';

const contract = new Contract('CCQ3Z4...');// replace with mock
try {
  let matIdBuffer = Buffer.from('mat-001'.padEnd(32, '\0'));
  const op = contract.call('has_entitlement',
    nativeToScVal(matIdBuffer, { type: 'bytesN', size: 32 }),
    new Address('GABC123...').toScVal() // fake address will fail but just for testing API
  );
  console.log("Success with nativeToScVal");
} catch (e) {
  console.error("Error with API:", e);
}
