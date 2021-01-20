<span align="center">

![Honeywell Evohome Controller](assets/TCC_EMEA.png)
# Honeywell Evohome support for Homebridge 
![npm](https://img.shields.io/npm/dt/homebridge-evohome)
![npm](https://img.shields.io/npm/v/homebridge-evohome)
[![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)


</span>

:warning: **Developers:** I am in the middle of refactoring the code! This might take some time. It will probably be part of the next release. Please let me know if you plan to contribute?  

This ia a plugin for Honeywell evohome. It is a partially-working implementation into HomeKit. This plugin is work in progress. Help is appreciated!

Up until now this plugin will only add your Thermostats and central functions (for example "ECO") to Homebridge. Other devices such as domestic hot water will probably follow in the future once we can wrap our heads arround it.

## Installation

**via homebridge-config-ui-x:**
1. Install homebridge and homebridge-config-ui-x.
2. Go to the "Plugins" tab and search for `homebridge-evohome`
3. Install the plugin and fill out the setup form

**via NPM:**
1. Install homebridge using: `npm install -g homebridge`
2. Install this plugin using `npm install -g homebridge-evohome@latest`
3. Update your configuration file. See sample-config below for a sample.

## Configuration

Configuration sample:

```
"platforms": [
        {
            "platform": "Evohome",
            "name" : "Evohome",
            "username" : "username/email",
            "password" : "password",
            "temperatureUnit" : "Celsius",
            "locationIndex" : "0"
        }
    ]
```

| Parameter          | optional | accepted values               | info |
| :--                | :--      | :--                           | :-- |
| `platform`         | no       | Evohome                       | |
| `name`             | no       | *any Name you want*           | |
| `username`         | no       | *your Honeywell email adress* | |
| `password`         | no       | *your Honeywell password*     | |
| `temperatureUnit`  | yes      | Celsius, Fahrenheit           | defaults to Celsius |
| `locationIndex`    | yes      | 0, 1, 2, etc.                 | only needed if you have multiple locations |
| `switchAway`       | yes      | true, false                   | creates a switch for away mode |
| `switchDayOff`     | yes      | true, false                   | creates a switch for day off mode |
| `switchEco`        | yes      | true, false                   | creates a switch for eco settings |
| `switchHeatingOff` | yes      | true, false                   | creates a switch to tur off the heating |
| `switchCustom`     | yes      | true, false                   | creates a switch four cour custom mode |


## Roadmap

- [x] Read temperature
- [x] Update temperature
- [x] Get device names
- [x] Set target temperature (credits to @zizzex)
- [x] Change temperature until next scheduled event (credits to @fredericvl). This feature sets the temperature until the next scheduled event on the same day. If there is no event on the same day it will be scheduled until 00:00:00. As this is a new feature it contains advanced logging. Please post your log if you encounter any problems.
- [x] Make use of Elgato Eve graphs (using fakegato-history) including automatic updating (credits to @rooi)
- [x] Add "global device" to add Away/Energy saving etc. (credits to @fredericvl)
- [x] Add support for multiple locations. (credits to @ebarnard)
- [x] Add support for Honeywell Round Connected.
- [ ] Add "DOMESTIC_HOT_WATER" with matching characteristics. This device will now be ignored to prevent errors (credits to @sOckhamSter)

## Known Issues & Notes

- System time/time zone must be the same as the time on your evohome controller or else schedules will work in unexpected ways.
- Your password may not contain `&` or else the login will fail.
- Updating from `<0.5.1` to `>0.6.0` will create new devices and put them into the standard room of your home. They just need to be moved back to their rooms. This is expected behaviour as the UUID has changed. Historic data will be retained. This can also happen without a clear cause. It is under investigation here: [#61](../../issues/61).
