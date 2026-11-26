/** How long ago, from whole minutes: minutes under an hour, then hours, then days (one formatter for every "ago" in minutes). */
export const agoEn = (minutes: number) => {
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} hr ago`;
  const days = Math.floor(minutes / 1440);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
};
export const agoEs = (minutes: number) => {
  if (minutes < 60) return `hace ${minutes} min`;
  if (minutes < 1440) return `hace ${Math.floor(minutes / 60)} h`;
  const days = Math.floor(minutes / 1440);
  return `hace ${days} ${days === 1 ? 'día' : 'días'}`;
};
