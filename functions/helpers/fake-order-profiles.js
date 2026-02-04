const FIRST_NAMES = [
  'Aiden','Bella','Caleb','Dahlia','Elias','Fiona','Grayson','Hazel','Isaac','Jade',
  'Kaia','Landon','Maya','Noah','Olive','Parker','Quinn','Riley','Silas','Tessa',
  'Uriel','Vera','Wyatt','Ximena','Yara','Zane','Amara','Beckett','Cara','Dorian',
  'Ember','Felix','Gia','Holden','Indie','Jasper','Kora','Leo','Mila','Nico',
  'Opal','Paxton','Reese','Soren','Thalia','Ulises','Violet','Weston','Xander','Zuri'
];

const LAST_NAMES = [
  'Andrews','Bennett','Carmichael','Dalton','Ellison','Fletcher','Garrett','Hayes','Irving','Jenkins',
  'Kensington','Lambert','Montoya','Nolan','Oakley','Prescott','Quincy','Rutledge','Sullivan','Turner',
  'Underwood','Vasquez','Whitaker','Xavier','Young','Zimmerman','Avery','Barton','Coleman','Drake',
  'Everett','Fisher','Gibson','Holland','Ingram','Jacobs','Keller','Lawson','Maddox','Newton',
  'Osborne','Patterson','Ramsey','Sawyer','Talbot','Upton','Valencia','Walker','Yates','Zavala'
];

const STREET_NAMES = [
  'Willow','Maple','Cedar','Pine','Birch','Magnolia','Aspen','Hawthorn','Chestnut','Sycamore',
  'Oak','Laurel','Juniper','Dogwood','Elm','Poplar','Spruce','Cottonwood','Alder','Sequoia',
  'Briar','River','Foxglove','Heron','Ivy','Lakeview','Hidden Glen','Prairie','Silver Leaf','Summit',
  'Harvest','Autumn','Winding Ridge','Canyon','Coral','Crystal','Golden Meadow','Harbor','Indigo','Lilac',
  'Marigold','Meadowlark','Pebble Creek','Quail Run','Redbud','Sage','Timber','Valley View','Whispering Wind','Yellow Brick'
];

const STREET_SUFFIXES = ['St','Ave','Rd','Dr','Ln','Way','Pl','Ct','Blvd','Terrace'];

const CITY_STATE_DEFINITIONS = [
  { city: 'Austin', state: 'TX', zipStart: 73301 },
  { city: 'Denver', state: 'CO', zipStart: 80201 },
  { city: 'Seattle', state: 'WA', zipStart: 98101 },
  { city: 'Phoenix', state: 'AZ', zipStart: 85001 },
  { city: 'Chicago', state: 'IL', zipStart: 60601 },
  { city: 'Miami', state: 'FL', zipStart: 33101 },
  { city: 'Brooklyn', state: 'NY', zipStart: 11201 },
  { city: 'San Diego', state: 'CA', zipStart: 92101 },
  { city: 'Portland', state: 'OR', zipStart: 97201 },
  { city: 'Atlanta', state: 'GA', zipStart: 30301 },
  { city: 'Raleigh', state: 'NC', zipStart: 27601 },
  { city: 'Salt Lake City', state: 'UT', zipStart: 84101 },
  { city: 'Minneapolis', state: 'MN', zipStart: 55401 },
  { city: 'Nashville', state: 'TN', zipStart: 37201 },
  { city: 'Boston', state: 'MA', zipStart: 02108 },
  { city: 'Las Vegas', state: 'NV', zipStart: 88901 },
  { city: 'Kansas City', state: 'MO', zipStart: 64101 },
  { city: 'Columbus', state: 'OH', zipStart: 43004 },
  { city: 'Boulder', state: 'CO', zipStart: 80301 },
  { city: 'Madison', state: 'WI', zipStart: 53703 }
];

const EMAIL_DOMAINS = [
  'examplemail.com','maildemo.net','postalcabin.org','courierhub.io','paperplane.co'
];

const AREA_CODES = ['305','415','503','612','678','702','801','917','980','512','312','206','213','404','602'];

const PROFILE_COUNT = 5000;

function padZip(value) {
  const numeric = Math.max(0, Math.floor(value));
  return numeric.toString().padStart(5, '0');
}

function buildPhone(areaCodeIndex, profileIndex) {
  const areaCode = AREA_CODES[areaCodeIndex % AREA_CODES.length];
  const prefix = 200 + (profileIndex % 600);
  const lineNumber = (1000 + (profileIndex * 37) % 9000).toString().padStart(4, '0');
  return `(${areaCode}) ${prefix.toString().padStart(3, '0')}-${lineNumber}`;
}

function buildProfiles() {
  const profiles = [];
  for (let index = 0; index < PROFILE_COUNT; index += 1) {
    const first = FIRST_NAMES[index % FIRST_NAMES.length];
    const last = LAST_NAMES[Math.floor(index / FIRST_NAMES.length) % LAST_NAMES.length];
    const streetNumber = 100 + ((index * 3) % 8900);
    const streetName = STREET_NAMES[(index * 7) % STREET_NAMES.length];
    const streetSuffix = STREET_SUFFIXES[index % STREET_SUFFIXES.length];
    const cityState = CITY_STATE_DEFINITIONS[(index * 5) % CITY_STATE_DEFINITIONS.length];
    const zipCode = padZip(cityState.zipStart + (index % 50));
    const areaCodeIndex = (index * 11) % AREA_CODES.length;
    const phoneNumber = buildPhone(areaCodeIndex, index);
    const domain = EMAIL_DOMAINS[index % EMAIL_DOMAINS.length];
    const email = `${first}.${last}.${(index + 1).toString().padStart(4, '0')}@${domain}`.toLowerCase();

    profiles.push({
      profileId: `SIM-${(index + 1).toString().padStart(4, '0')}`,
      fullName: `${first} ${last}`,
      email,
      phoneNumber,
      streetAddress: `${streetNumber} ${streetName} ${streetSuffix}`,
      city: cityState.city,
      state: cityState.state,
      zipCode,
      country: 'US'
    });
  }

  return profiles;
}

const FAKE_ORDER_PROFILES = buildProfiles();

module.exports = { FAKE_ORDER_PROFILES };
