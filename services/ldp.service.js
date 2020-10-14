const { LdpService } = require('@semapps/ldp');
const ontologies = require('../ontologies.json');

module.exports = {
  mixins: [LdpService],
  settings: {
    baseUrl: process.env.SEMAPPS_HOME_URL,
    containers: [],
    ontologies
  }
};
