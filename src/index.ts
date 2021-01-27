import { API } from 'homebridge';
import { PLATFORM_NAME } from './settings';
import { HoneywellEvohomePlattform } from './platform';

/**
 * This mehtod registers the platform with Homebridge
 */
export = (api: API): void => {
    api.registerPlatform(PLATFORM_NAME, HoneywellEvohomePlattform);
}