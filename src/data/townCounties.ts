// Generated from public/data/towns.json (US Census Bureau TIGER/Line 2026 county subdivisions, public domain).
// Town name -> county, for the map label on the home screen only. Towns not listed get a plain "New Jersey" label.
const BY_COUNTY: Record<string, readonly string[]> = {
  Bergen: ["Bergenfield", "Bogota", "Carlstadt", "Cliffside Park", "Closter", "Dumont", "East Rutherford", "Edgewater", "Elmwood Park", "Emerson", "Englewood", "Fair Lawn", "Fairview", "Fort Lee", "Garfield", "Glen Rock", "Hackensack", "Harrington Park", "Hasbrouck Heights", "Haworth", "Hillsdale", "Ho-Ho-Kus", "Leonia", "Little Ferry", "Lodi", "Lyndhurst", "Maywood", "Midland Park", "Moonachie", "New Milford", "Oradell", "Palisades Park", "Paramus", "Ridgefield", "Ridgefield Park", "Ridgewood", "River Edge", "River Vale", "Rochelle Park", "Rutherford", "Saddle Brook", "South Hackensack", "Teaneck", "Teterboro", "Waldwick", "Wallington", "Washington", "Westwood", "Wood-Ridge", "Wyckoff"],
  Hudson: ["Guttenberg", "Hoboken", "Jersey City", "North Bergen", "Secaucus", "Union City", "Weehawken", "West New York"],
  Passaic: ["Clifton", "Hawthorne", "Passaic", "Paterson"],
};
const COUNTY = new Map(Object.entries(BY_COUNTY).flatMap(([county, towns]) => towns.map(town => [town.toLowerCase(), county] as const)));
/** The county of a New Jersey town in Dale's corridor, or undefined when the town is not in the Census list Dale ships. */
export const townCounty = (town: string): string | undefined => COUNTY.get(town.trim().toLowerCase());
