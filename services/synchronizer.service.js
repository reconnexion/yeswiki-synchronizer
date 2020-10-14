const urlJoin = require('url-join');
const { BotService, ACTIVITY_TYPES } = require('@semapps/activitypub');

const SynchronizerService = {
  name: 'synchronizer',
  mixins: [BotService],
  settings: {
    actor: {
      username: 'yeswiki-synchronizer-bot',
      name: 'YesWiki Synchronizer Bot'
    },
    restApis: {
      notes: {
        actorAccount: 'srosset@mastodon.social',
        objectType: 'Note',
        yeswikiUri: 'http://localhost',
        formId: 3,
        headers: {
          // 'X-Auth-Token': 'Bearer ' + TOKEN
        },
        transformData: object => {
          object.summary = object.content.substring(0, 20);
          return object;
        }
      },
      projects: {
        actorAccount: 'lafabrique@colibris.social',
        actorUri: 'https://colibris.social/actors/lafabrique',
        objectType: 'pair:Project',
        yeswikiUri: 'http://localhost',
        formId: 1,
        headers: {},
        transformData: object => {
          object.image = object.image.url;
          return object;
        }
      }
    }
  },
  async started() {
    for (let apiKey in this.settings.restApis) {
      if (!this.settings.restApis[apiKey].actorUri) {
        const uri = await this.broker.call('webfinger.getRemoteUri', {
          account: this.settings.restApis[apiKey].actorAccount
        });
        if (uri) {
          this.settings.restApis[apiKey].actorUri = uri;
        } else {
          throw new Error('Unable to find remote actor ' + this.settings.restApis[apiKey].actorAccount);
        }
      }
    }
  },
  actions: {
    async followActors(ctx) {
      for (let apiKey in this.settings.restApis) {
        // We can't be sure to use actorUri because started() has not been called yet
        const uri =
          this.settings.restApis[apiKey].actorUri ||
          (await this.broker.call('webfinger.getRemoteUri', { account: this.settings.restApis[apiKey].actorAccount }));
        await ctx.call('activitypub.outbox.post', {
          username: this.settings.actor.username,
          '@context': 'https://www.w3.org/ns/activitystreams',
          actor: this.settings.actor.uri,
          type: ACTIVITY_TYPES.FOLLOW,
          object: uri,
          to: [uri, urlJoin(this.settings.actor.uri, 'followers')]
        });
      }
    },
    async createObject(ctx) {
      const { apiKey, object } = ctx.params;
      console.log('create object', JSON.stringify(this.settings.restApis[apiKey].transformData(object)));
      const wikiPage = await this.actions.getWikiPage({ sourceUrl: this.getObjectId(object), apiKey });
      if (!wikiPage) {
        const response = await fetch(this.getContainerUri(apiKey), {
          method: 'POST',
          headers: {
            ...this.settings.restApis[apiKey].headers,
            'Source-Url': this.getObjectId(object),
            'Content-Type': 'application/ld+json'
          },
          body: JSON.stringify(this.settings.restApis[apiKey].transformData(object))
        });
        // TODO return error
        if (!response.ok) {
          const json = await response.json();
          console.log('Error returned by ' + this.getContainerUri(apiKey) + ': ' + json.error);
        }
      } else {
        // If a page already exist with this sourceUrl, update it
        return await this.actions.updateObject({ apiKey, object });
      }
    },
    async updateObject(ctx) {
      const { apiKey, object } = ctx.params;
      const wikiPage = await this.actions.getWikiPage({ sourceUrl: this.getObjectId(object), apiKey });
      if (wikiPage) {
        const response = await fetch(wikiPage, {
          method: 'PATCH',
          headers: {
            ...this.settings.restApis[apiKey].headers,
            'Content-Type': 'application/ld+json'
          },
          body: JSON.stringify(this.settings.restApis[apiKey].transformData(object))
        });
        return response.ok;
      } else {
        // If no page exist with this sourceUrl, create it
        return await this.actions.createObject({ apiKey, object });
      }
    },
    async deleteObject(ctx) {
      const { apiKey, object } = ctx.params;
      const wikiPage = await this.actions.getWikiPage({ sourceUrl: this.getObjectId(object), apiKey });
      if (wikiPage) {
        const response = await fetch(wikiPage, {
          method: 'DELETE',
          headers: {
            ...this.settings.restApis[apiKey].headers,
            'Content-Type': 'application/ld+json'
          }
        });
        return response.ok;
      } else {
        throw new Error('No wiki page found with source URL ' + this.getObjectId(object));
      }
    },
    async getWikiPage(ctx) {
      const { apiKey, sourceUrl } = ctx.params;
      const response = await fetch(
        urlJoin(this.settings.restApis[apiKey].yeswikiUri, '?api/fiche/url/' + encodeURIComponent(sourceUrl))
      );
      if (response.ok) {
        const wikiPages = await response.json();
        return wikiPages[0];
      }
    }
  },
  methods: {
    actorCreated(actor) {
      this.actions.followActors();
    },
    inboxReceived(activity) {
      // TODO uniformize context
      console.log('inbox received', activity);

      const matchingApisKeys = this.getMatchingApis(activity);
      console.log('matchingApisKeys', matchingApisKeys);

      if (matchingApisKeys) {
        matchingApisKeys.map(apiKey => {
          switch (activity.type) {
            case ACTIVITY_TYPES.CREATE: {
              this.actions.createObject({ apiKey, object: activity.object });
              break;
            }

            case ACTIVITY_TYPES.UPDATE: {
              this.actions.updateObject({ apiKey, object: activity.object });
              break;
            }

            case ACTIVITY_TYPES.DELETE: {
              this.actions.deleteObject({ apiKey, object: activity.object });
              break;
            }

            default: {
              // Ignore all other activities
              // TODO handle Announce activity
              break;
            }
          }
        });
      }
    },
    getMatchingApis(activity) {
      return Object.keys(this.settings.restApis).filter(
        apiKey =>
          activity.actor === this.settings.restApis[apiKey].actorUri &&
          (activity.type === ACTIVITY_TYPES.DELETE ||
            (activity.object && Array.isArray(activity.object.type)
              ? activity.object.type.includes(this.settings.restApis[apiKey].objectType)
              : activity.object.type === this.settings.restApis[apiKey].objectType))
      );
    },
    getContainerUri(apiKey) {
      return urlJoin(this.settings.restApis[apiKey].yeswikiUri, '?api/fiche/' + this.settings.restApis[apiKey].formId);
    },
    getObjectId(object) {
      return object.id || object['@id'];
    }
  }
};

module.exports = SynchronizerService;
