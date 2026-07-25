import { Client as HubSpotClient } from '@hubspot/api-client';
import { config } from '../config';

export const hubspotClient = new HubSpotClient({ accessToken: config.hubspot.accessToken });
