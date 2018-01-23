# homebridge-evohome

***!Attention: The old Version (<0.1.1) is no longer working due to a change in the API-URL. Please update.***

This ia a plugin for Honeywell evohome. It is a partially-working implementation into HomeKit. This plugin is work in progress. Help is appreciated!

Up until now this plugin will only add your Thermostats to Homebridge. Other devices such as domestic hot water or the central unit itself with modes such as away or vacation will probably follow in the future once the basic problems are fixed.

# Installation

This plugin is not yet on NPM. Insatllation only via GitHub at the moment...

1. Install homebridge using: npm install -g homebridge <br>
2. Install this plugin using npm install -g homebridge-evohome
3. Update your configuration file. See sample-config below for a sample.

# Configuration

Configuration sample:

```
"platforms": [
        {
            "platform": "Evohome",
            "name" : "Evohome",
            "username" : "username/email",
            "password" : "password",
            "temperatureUnit" : "Celsius"
        }
    ]
```

- platform: Evohome
- name: can be anything you want
- username: your Honeywell e-mail
- password: your Honeywell password
- temperatureUnit: Celsius / Fahrenheit

# Roadmap

- ~~get temperature~~
- ~~update temperature~~
- ~~get device name~~
- ~~set target temperature~~ (credits to @zizzex)
- ~~change temperature until next scheduled event~~ (credits to @fredericvl)
   - This feature sets the temperature until the next scheduled event on the same day. If there is no event on the same day it will be scheduled until 00:00:00. As this is a new feature it contains advanced logging. Please post your log if you encounter any problems.
- ~~make use of elgato eve graphs including automatic updating~~ (credits to @rooi)
- ~~add "global device" to add Away/Energy saving etc.~~ (credits to @fredericvl)
- add "DOMESTIC_HOT_WATER" with matching characteristics. This device will now be ignored to prevent errors (credits to @sOckhamSter)
- add support for multiple locations. (in beta right now: see the multiple-locations branch)

# Notes

It seems to be vitally important to set the right system time, especially on raspi!
