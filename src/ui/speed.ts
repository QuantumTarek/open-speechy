// "1×", "1.25×": up to two decimals, so 1.25 is not shown as 1.3.
export function formatSpeed(speed: number): string {
  return `${Number(speed.toFixed(2))}×`;
}
