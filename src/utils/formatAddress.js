export function formatAddress(address, startChars = 6, endChars = 4) {
  if (!address) return '';
  if (address.length <= startChars + endChars) return address;

  return `${address.slice(0, startChars)}...${address.slice(-endChars)}`;
}

export function formatHash(hash, startChars = 8, endChars = 6) {
  return formatAddress(hash, startChars, endChars);
}

export function formatBalance(balance, decimals = 4) {
  if (!balance) return '0';
  const num = typeof balance === 'string' ? parseFloat(balance) : balance;
  return num.toFixed(decimals);
}
