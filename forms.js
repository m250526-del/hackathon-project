'use strict';

const { validateName, validateCnic, validateDob, validateAddress, validatePhone, validateCount, makeChoiceValidator } = require('./validators');

const nameErrors = {
  bad_length: 'Naam bohat chota ya bohat lamba hai.',
  bad_chars: 'Naam mein number ya khaas nishan nahi hone chahiye.',
};

const fullName = {
  key: 'full_name',
  label: 'Naam',
  validate: validateName,
  ask: 'Apna poora naam likhein.',
  help: 'Apna poora naam sirf huroof mein likhein, jaise: Muhammad Ali. Koi number ya nishan na likhein.',
  errors: nameErrors,
};

const fatherName = {
  key: 'father_name',
  label: 'Walid ka naam',
  validate: validateName,
  ask: 'Apne walid (father) ka poora naam likhein.',
  help: 'Walid (abu) ka poora naam sirf huroof mein likhein, jaise: Abdul Rehman.',
  errors: nameErrors,
};

const cnic = {
  key: 'cnic',
  label: 'CNIC',
  sensitive: true,
  digits: 13,
  validate: validateCnic,
  ask: 'Apna CNIC number likhein (13 hindse).',
  help: 'CNIC aap ke shanakhti card par chhapa hota hai: 13 hindson ka number, jaise 35202-1234567-1. Dash ke saath ya baghair dono theek hain. Agar card paas nahi to purana form ya B-Form dekh lein.',
  errors: {
    not_a_number: 'CNIC mein sirf hindse (0-9) hone chahiye.',
    wrong_length: (r) => `CNIC 13 hindson ka hota hai, aap ne ${r.digitsFound} hindse likhe.`,
  },
};

const dob = {
  key: 'dob',
  label: 'Tareekh-e-paidaish',
  validate: validateDob,
  ask: 'Apni tareekh-e-paidaish likhein, is tarah: din-mahina-saal (jaise 15-08-1990).',
  help: 'Tareekh is tarah likhein: din-mahina-saal, jaise 15-08-1990 (15 August 1990).',
  errors: {
    bad_format: 'Tareekh ka tareeqa durust nahi. Is tarah likhein: 15-08-1990.',
    bad_date: 'Ye tareekh durust nahi lagti. Dobara check karein.',
  },
};

const address = {
  key: 'address',
  label: 'Pata',
  validate: validateAddress,
  ask: 'Apna mukammal pata likhein (ghar number, mohalla, shehar).',
  help: 'Poora pata likhein, jaise: House 12, Gali 3, Shah Rukn-e-Alam Colony, Multan.',
  errors: { bad_length: 'Pata bohat chota ya bohat lamba hai. Mukammal pata likhein.' },
};

const phone = {
  key: 'phone',
  label: 'Mobile number',
  digits: 11,
  validate: validatePhone,
  ask: 'Apna mobile number likhein (jaise 03001234567).',
  help: 'Mobile number 11 hindson ka hota hai aur 03 se shuru hota hai, jaise 03001234567.',
  errors: {
    not_a_number: 'Mobile number mein sirf hindse hone chahiye.',
    wrong_length: (r) => `Mobile number 11 hindson ka hota hai, aap ne ${r.digitsFound} hindse likhe.`,
    bad_format: 'Mobile number 03 se shuru hona chahiye.',
  },
};

const familySize = {
  key: 'family_size',
  label: 'Ghar ke afraad',
  validate: (t) => validateCount(t, 1, 20),
  ask: 'Aap ke ghar mein kitne afraad hain? Sirf number likhein.',
  help: 'Un sab logon ki ginti likhein jo aap ke saath ek ghar mein rehte hain, jaise 6.',
  errors: {
    not_a_number: 'Sirf number likhein, jaise 6.',
    bad_range: 'Number 1 se 20 ke darmiyan hona chahiye.',
  },
};

const licenseType = {
  key: 'license_type',
  label: 'License ki qism',
  validate: makeChoiceValidator(['Motorcycle', 'Car', 'Rickshaw']),
  ask: 'License ki qism chunein:\n1 - Motorcycle\n2 - Car\n3 - Rickshaw',
  help: 'Motorcycle ke liye 1, gaari (car) ke liye 2, rickshaw ke liye 3 likhein.',
  errors: { bad_choice: 'Meharbani kar ke 1, 2 ya 3 likhein.' },
};

const FORMS = {
  id_card: {
    title: 'Shanakhti card (ID card) - demo',
    intro: 'Theek hai, hum shanakhti card ka demo form bharte hain. Main aap se ek ek kar ke sawal poochunga. Agar kisi bhi waqt peechay jana ho ya shuru se karna ho to bas bata dein.',
    fields: [fullName, fatherName, cnic, dob, address],
  },
  health_card: {
    title: 'Sehat card - demo',
    intro: 'Theek hai, hum sehat card ka demo form bharte hain. Main aap se ek ek kar ke sawal poochunga. Agar kisi bhi waqt peechay jana ho ya shuru se karna ho to bas bata dein.',
    fields: [fullName, cnic, dob, phone, familySize],
  },
  license: {
    title: 'Driving license - demo',
    intro: 'Theek hai, hum driving license ka demo form bharte hain. Main aap se ek ek kar ke sawal poochunga. Agar kisi bhi waqt peechay jana ho ya shuru se karna ho to bas bata dein.',
    fields: [fullName, cnic, dob, licenseType, address],
  },
};

module.exports = { FORMS };
