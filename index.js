// This platform integrates Honeywell Evohome into homebridge
// As I only own a few thermostats and no window sensors I have not yet integrated them.
//
// The configuration is stored inside the ../config.json
// {
//     "platform": "Evohome",
//     "name" : "Evohome",
//     "username" : "username/email",
//     "password" : "password",
//     "lcoationIndex" : "locationIndex"
// }
//

'use strict';

var evohome = require('./lib/evohome.js');
var Service, Characteristic;
var config;
var FakeGatoHistoryService;
var inherits = require('util').inherits;
const moment = require('moment');
var CustomCharacteristic = {};

module.exports = function(homebridge) {
    FakeGatoHistoryService = require('fakegato-history')(homebridge);

    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;

    CustomCharacteristic.ValvePosition = function() {
        Characteristic.call(this, 'Valve position', 'E863F12E-079E-48FF-8F27-9C2605A29F52');
        this.setProps({
                      format: Characteristic.Formats.UINT8,
                      unit: Characteristic.Units.PERCENTAGE,
                      perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
                      });
        this.value = this.getDefaultValue();
    };
    inherits(CustomCharacteristic.ValvePosition, Characteristic);

    CustomCharacteristic.ProgramCommand = function() {
        Characteristic.call(this, 'Program command', 'E863F12C-079E-48FF-8F27-9C2605A29F52');
        this.setProps({
                      format: Characteristic.Formats.DATA,
                      perms: [Characteristic.Perms.WRITE, Characteristic.Perms.NOTIFY]
                      });
        this.value = this.getDefaultValue();
    };
    inherits(CustomCharacteristic.ProgramCommand, Characteristic);

    CustomCharacteristic.ProgramData = function() {
        Characteristic.call(this, 'Program data', 'E863F12F-079E-48FF-8F27-9C2605A29F52');
        this.setProps({
                      format: Characteristic.Formats.DATA,
                      perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
                      });
        this.value = this.getDefaultValue();
    };
    inherits(CustomCharacteristic.ProgramData, Characteristic);

    homebridge.registerPlatform("homebridge-evohome", "Evohome", EvohomePlatform);
}

function EvohomePlatform(log, config){

    this.sessionObject = null;
    this.name = config['name'];
    this.username = config['username'];
    this.password = config['password'];
    this.temperatureUnit = config['temperatureUnit'];

    this.locationIndex = config['locationIndex'] || 0;
    
    this.switchAway = config['switchAway']; //set to false to hide 
    this.switchDayOff = config['switchDayOff'];
    this.switchEco = config['switchEco'];
    this.switchHeatingOff = config['switchHeatingOff'];
    this.switchCustom = config['switchCustom'];

    this.cache_timeout = 300; // seconds
    this.interval_setTemperature = 5; // seconds

    this.systemMode = "";

    this.log = log;

    this.updating = false;
}

EvohomePlatform.prototype = {

    accessories: function(callback) {
        this.log("Logging into Evohome...");

        var that = this;
        // create the myAccessories array
        this.myAccessories = [];

        evohome.login(that.username, that.password).then(function(session) {
            this.log("Logged into Evohome!");
            this.sessionObject = session;

            session.getLocations().then(function(locations){
                this.log('You have', locations.length, 'location(s). This instance will be using Index No', that.locationIndex);
                this.log('You have', locations[that.locationIndex].devices.length, 'device(s).')

                session.getThermostats(locations[that.locationIndex].locationID).then(function(thermostats){

                    session.getSystemModeStatus(locations[that.locationIndex].locationID).then(function(systemModeStatus){

                        // iterate through the devices
                        for (var deviceId in locations[that.locationIndex].devices) {
                            for(var thermoId in thermostats) {
                                if(locations[that.locationIndex].devices[deviceId].zoneID == thermostats[thermoId].zoneId) {
                                    // print name of the device
                                    this.log(deviceId + ": " + locations[that.locationIndex].devices[deviceId].name + " (" + thermostats[thermoId].temperatureStatus.temperature + "°)");

                                    if(locations[that.locationIndex].devices[deviceId].name  == "") {
                                        // Device name is empty
                                        // Probably Hot Water
                                        // Do not store
                                        this.log("Found blank device name, probably stored hot water. Ignoring device for now.");
                                    }
                                    else {
                                        // store device in var
                                        var device = locations[that.locationIndex].devices[deviceId];
                                        // store thermostat in var
                                        var thermostat = thermostats[thermoId];
                                        // store name of device
                                        var name = locations[that.locationIndex].devices[deviceId].name + " Thermostat";
                                        // timezone offset in minutes
                                        var offsetMinutes = locations[that.locationIndex].timeZone.offsetMinutes;
                                        // create accessory (only if it is "HeatingZone")
                                        if (device.modelType == "HeatingZone") {
                                            var accessory = new EvohomeThermostatAccessory(that, that.log, name, device, locations[that.locationIndex].systemId, deviceId, thermostat, this.temperatureUnit, this.username, this.password, this.interval_setTemperature, offsetMinutes);
                                            // store accessory in myAccessories
                                            this.myAccessories.push(accessory);
                                        }
                                    }
                                }
                            }
                        }

                        this.systemMode = systemModeStatus.mode;

                    if(this.switchAway != false){
                        var awayAccessory = new EvohomeSwitchAccessory(that, that.log, that.name + " Away Mode", locations[that.locationIndex].systemId, "Away", (systemModeStatus.mode == "Away" ? true : false), this.username, this.password);
                        this.myAccessories.push(awayAccessory);
					}

					if(this.switchDayOff != false){
                        var dayOffAccessory = new EvohomeSwitchAccessory(that, that.log, that.name + " Day Off Mode", locations[that.locationIndex].systemId, "DayOff", (systemModeStatus.mode == "DayOff" ? true : false), this.username, this.password);
                        this.myAccessories.push(dayOffAccessory);
					}
					
					if(this.switchHeatingOff != false){
                        var heatingOffAccessory = new EvohomeSwitchAccessory(that, that.log, that.name + " Heating Off Mode", locations[that.locationIndex].systemId, "HeatingOff", (systemModeStatus.mode == "HeatingOff" ? true : false), this.username, this.password);
                        this.myAccessories.push(heatingOffAccessory);
					}
					
					if(this.switchEco != false){
                        var ecoAccessory = new EvohomeSwitchAccessory(that, that.log, that.name + " Eco Mode", locations[that.locationIndex].systemId, "AutoWithEco", (systemModeStatus.mode == "AutoWithEco" ? true : false), this.username, this.password);
                        this.myAccessories.push(ecoAccessory);
					}

					if(this.switchCustom != false){
                        var customAccessory = new EvohomeSwitchAccessory(that, that.log, that.name + " Custom Mode", locations[that.locationIndex].systemId, "Custom", (systemModeStatus.mode == "Custom" ? true : false), this.username, this.password);
                        this.myAccessories.push(customAccessory);
					}

                        callback(this.myAccessories);

                        setInterval(that.renewSession.bind(this), session.refreshTokenInterval * 1000);
                        setInterval(that.periodicUpdate.bind(this), this.cache_timeout * 1000);

                    }.bind(this)).fail(function(err){
                        that.log('Evohome failed:', err);
                    });

                }.bind(this)).fail(function(err){
                    that.log('Evohome failed:', err);
                });

            }.bind(this)).fail(function(err){
                that.log('Evohome Failed:', err);
            });

        }.bind(this)).fail(function(err) {
            // tell me if login did not work!
            that.log("Error during Login:", err);
        });
    }
};

EvohomePlatform.prototype.renewSession = function() {
    var that = this;
    var session = this.sessionObject;
    session._renew().then(function(json) {
        // renew session token
        session.sessionId = "bearer " + json.access_token;
        session.refreshToken = json.refresh_token;
        that.log("Renewed Honeywell API authentication token!");
    }).fail(function(err) {
        this.log('Renewing Honeywell API authentication token failed:', err);
    });
}

EvohomePlatform.prototype.periodicUpdate = function() {
    
    if(!this.updating && this.myAccessories){
        this.updating = true;

        var session = this.sessionObject;

        session.getLocations().then(function(locations){

            session.getThermostats(locations[this.locationIndex].locationID).then(function(thermostats){

                session.getSystemModeStatus(locations[this.locationIndex].locationID).then(function(systemModeStatus){
                    this.systemMode = systemModeStatus.mode;

                    var updatedAwayActive = false;
                    var updatedDayOffActive = false;
                    var updatedHeatingOffActive = false;
                    var updatedEcoActive = false;
                    var updatedCustomActive = false;

                    for (var deviceId in locations[this.locationIndex].devices) {
                        for(var thermoId in thermostats) {
                            if(locations[this.locationIndex].devices[deviceId].zoneID == thermostats[thermoId].zoneId) {
                                for(var i=0; i<this.myAccessories.length; ++i) {
                                    if(this.myAccessories[i].device != null && this.myAccessories[i].device.zoneID == locations[this.locationIndex].devices[deviceId].zoneID) {

                                        var device = locations[this.locationIndex].devices[deviceId];
                                        var thermostat = thermostats[thermoId];

                                        if(device) {
                                            // Check if temp has changed
                                            var oldCurrentTemp = this.myAccessories[i].thermostat.temperatureStatus.temperature;
                                            var newCurrentTemp = thermostat.temperatureStatus.temperature;
                                            var oldTargetTemp = this.myAccessories[i].thermostat.setpointStatus.targetHeatTemperature;
                                            var newTargetTemp = thermostat.setpointStatus.targetHeatTemperature;

                                            // retrieve service, update stored device and thermostat    
                                            var service = this.myAccessories[i].thermostatService;
                                            this.myAccessories[i].device = device;
                                            this.myAccessories[i].thermostat = thermostat;

                                            if(oldCurrentTemp!=newCurrentTemp && service) {
                                                this.log("Updating: " + device.name + " currentTempChange from: " + oldCurrentTemp + " to: " + newCurrentTemp);
                                            }
                                          
                                            if(oldTargetTemp!=newTargetTemp && service) {
                                                this.log("Updating: " + device.name + " targetTempChange from: " + oldTargetTemp + " to: " + newTargetTemp);
                                            }

                                            // notify homebridge of current temp and target because homekit's cached temperature might be wrong
                                            if (service) {
                                                // updateValue triggers a change event which notifies HomeKit
                                                service.getCharacteristic(Characteristic.CurrentTemperature)
                                                       .updateValue(Number(newCurrentTemp));

                                                service.getCharacteristic(Characteristic.TargetTemperature)
                                                        .updateValue(Number(newTargetTemp));     

                                                // if temperature or setpoint changed then CurrentHeatingCoolingState and TargetHeatingCoolingState might have changed too
                                                // getValue will update HomeKit if the value is different to homebridge's cached value
                                                service.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
                                                    .getValue();

                                                service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
                                                    .getValue();
                                            }


                                            var loggingService = this.myAccessories[i].loggingService;

                                            //this.log("populating loggingService: " + loggingService);
                                            //this.log(moment().unix() + " " + newCurrentTemp + " " + newTargetTemp);
                                            loggingService.addEntry({time:moment().unix(), currentTemp:newCurrentTemp, setTemp:newTargetTemp, valvePosition:50}); // valve pos 50%???

                                        }

                                    } else if(!updatedAwayActive && this.myAccessories[i].systemMode == "Away") {
                                        updatedAwayActive = true;

                                        var newAwayActive = (systemModeStatus.mode == "Away") ? true : false;
                                        if(this.myAccessories[i].active != newAwayActive) {
                                            this.log("Updating system mode Away to " + newAwayActive);
                                            this.myAccessories[i].active = newAwayActive;
                                        }
                                    } else if(!updatedDayOffActive && this.myAccessories[i].systemMode == "DayOff") {
                                        updatedDayOffActive = true;

                                        var newDayOffActive = (systemModeStatus.mode == "DayOff") ? true : false;
                                        if(this.myAccessories[i].active != newDayOffActive) {
                                            this.log("Updating system mode DayOff to " + newDayOffActive);
                                            this.myAccessories[i].active = newDayOffActive;
                                        }
                                    } else if(!updatedHeatingOffActive && this.myAccessories[i].systemMode == "HeatingOff") {
                                        updatedHeatingOffActive = true;

                                        var newHeatingOffActive = (systemModeStatus.mode == "HeatingOff") ? true : false;
                                        if(this.myAccessories[i].active != newHeatingOffActive) {
                                            this.log("Updating system mode HeatingOff to " + newHeatingOffActive);
                                            this.myAccessories[i].active = newHeatingOffActive;
                                        }
                                    } else if(!updatedEcoActive && this.myAccessories[i].systemMode == "AutoWithEco") {
                                        updatedEcoActive = true;

                                        var newEcoActive = (systemModeStatus.mode == "AutoWithEco") ? true : false;
                                        if(this.myAccessories[i].active != newEcoActive) {
                                            this.log("Updating system mode Eco to " + newEcoActive);
                                            this.myAccessories[i].active = newEcoActive;
                                        }
                                    } else if(!updatedCustomActive && this.myAccessories[i].systemMode == "Custom") {
                                        updatedCustomActive = true;

                                        var newCustomActive = (systemModeStatus.mode == "Custom") ? true : false;
                                        if(this.myAccessories[i].active != newCustomActive) {
                                            this.log("Updating system mode Custom to " + newCustomActive);
                                            this.myAccessories[i].active = newCustomActive;
                                        }
                                    }
                                }
                            }
                        }
                    }

                }.bind(this)).fail(function(err){
                    this.log('Evohome Failed:', err);
                });

            }.bind(this)).fail(function(err){
                this.log('Evohome Failed:', err);
            });
        }.bind(this)).fail(function(err){
            this.log('Evohome Failed:', err);
        });

        this.updating = false;
    }
}

// give this function all the parameters needed
function EvohomeThermostatAccessory(platform, log, name, device, systemId, deviceId, thermostat, temperatureUnit, username, password, interval_setTemperature, offsetMinutes) {
    this.uuid_base = systemId + ":" + deviceId;
    this.name = name;

    this.displayName = name; // fakegato
    this.device = device;
    this.model = device.modelType;
    this.serial = deviceId;

    this.deviceId = deviceId;

    this.thermostat = thermostat;
    this.temperatureUnit = temperatureUnit;

    this.platform = platform;
    this.username = username;
    this.password = password;

    this.log = log;

    this.loggingService = new FakeGatoHistoryService("thermo", this, {
                                                     storage: 'fs'
                                                     });

    this.targetTemperateToSet = -1;

    this.offsetMinutes = offsetMinutes;

    setInterval(this.periodicCheckSetTemperature.bind(this), interval_setTemperature * 1000);
}

EvohomeThermostatAccessory.prototype = {

    periodicCheckSetTemperature: function() {
        var that = this;
        var session = that.platform.sessionObject;
        var value = that.targetTemperateToSet;

        if(value != -1) {
            session.getSchedule(that.device.zoneID).then(function (schedule) {

                var date = new Date();
                var utc = date.getTime() + (date.getTimezoneOffset() * 60000);
                var correctDate = new Date(utc + (60000 * that.offsetMinutes));
                var weekdayNumber = correctDate.getDay();
                var weekday = new Array(7);
                weekday[0]="Sunday";
                weekday[1]="Monday";
                weekday[2]="Tuesday";
                weekday[3]="Wednesday";
                weekday[4]="Thursday";
                weekday[5]="Friday";
                weekday[6]="Saturday";

                var currenttime = correctDate.toLocaleTimeString('de-DE', { timeZone: "Europe/Berlin", hour12: false});
                that.log("The current time is", currenttime);
                var proceed = true;
                var nextScheduleTime = "";

                for(var scheduleId in schedule) {
                    if(schedule[scheduleId].dayOfWeek == weekday[weekdayNumber]) {
                        that.log("Schedule points for today (" + schedule[scheduleId].dayOfWeek + ")")
                        var switchpoints = schedule[scheduleId].switchpoints;
                        for(var switchpointId in switchpoints) {
                            var logline = "- " + switchpoints[switchpointId].timeOfDay;
                            if(proceed == true) {
                                if(currenttime >= switchpoints[switchpointId].timeOfDay) {
                                    proceed = true;
                                } else if (currenttime < switchpoints[switchpointId].timeOfDay) {
                                    proceed = false;
                                    nextScheduleTime = switchpoints[switchpointId].timeOfDay;
                                    logline = logline + " -> next change";
                                }
                            }
                            that.log(logline);
                        }
                        if(proceed == true) {
                            nextScheduleTime = "00:00:00";
                        }
                    }
                }

                that.log("Setting target temperature for", that.name, "to", value + "° until " + nextScheduleTime);

                session.setHeatSetpoint(that.device.zoneID, value, nextScheduleTime).then(function (taskId) {
                    that.log("Successfully changed temperature!");
                    that.log(taskId);
                    // returns taskId if successful
                    that.targetTemperateToSet = -1;
                    that.thermostat.setpointStatus.targetHeatTemperature = value;
                    // set target temperature here also to prevent from setting temperature two times
                });
            }).fail(function(err) {
                that.log('Evohome failed:', err);
                that.targetTemperateToSet = -1;
                //callback(null, Number(0));
            });
        }
    },

    getCurrentTemperature: function(callback) {
        var that = this;

        // need to refresh data if outdated!!
        var currentTemperature = this.thermostat.temperatureStatus.temperature;
        callback(null, Number(currentTemperature));
        that.log("Current temperature of " + this.name + " is " + currentTemperature + "°");
    },

    getCurrentHeatingCoolingState: function(callback) {
        var that = this;

        // OFF  = 0
        // HEAT = 1
        // COOL = 2
        // AUTO = 3
        if (this.model == "HeatingZone"){
            var targetTemp = this.thermostat.setpointStatus.targetHeatTemperature;
            var currentTemp = this.thermostat.temperatureStatus.temperature;

            // state is HEAT if there is current call for heat, or OFF
            var state = (currentTemp < targetTemp) ? 1 : 0;
        } else {
            var state = 1;
            // domestic hot water not supported (set to heat by default)
        }
        callback(null, Number(state));

    },

    getName: function(callback) {

        var that = this;

        that.log("requesting name of", this.name);

        callback(this.name);

    },

    setTargetHeatingCooling: function(value, callback) {
        var that = this;
        var session = that.platform.sessionObject;

        // OFF  = 0
        // HEAT = 1
        // COOL = 2
        // AUTO = 3

        if(value == 0) { // OFF
            // set temperature to 5 degrees permanently when heating is "off"
            session.setHeatSetpoint(that.device.zoneID, 5, null).then(function (taskId) {
                that.log("Heating is set off for " + that.name + " (set to 5°)");
                that.log(taskId);
                // returns taskId if successful
                that.thermostat.setpointStatus.targetHeatTemperature = 5;
                // set target temperature here also to prevent from setting temperature two times
            });
        } else {
            // set thermostat to follow the schedule by passing 0 to the method
            session.setHeatSetpoint(that.device.zoneID, 0, null).then(function (taskId) {
                that.log("Cancelled override for " + that.name + " (set to follow schedule)");
                that.log(taskId);
                // returns taskId if successful
            });
        }

        callback(null);

    },

    getTargetHeatingCooling: function(callback) {
        var that = this;

        // OFF  = 0
        // HEAT = 1
        // COOL = 2
        // AUTO = 3
        if (this.model == "HeatingZone"){
            var targetTemp = this.thermostat.setpointStatus.targetHeatTemperature;
            var state = (targetTemp == 5) ? 0 : 1;
        } else {
            var state = 1;
            // domestic hot water not supported (set to heat by default)
        }
        callback(null, Number(state));

    },

    setTargetTemperature: function(value, callback) {
        var that = this;

        that.targetTemperateToSet = value;
        callback(null, Number(1));
    },

    getTargetTemperature: function(callback) {
        var that = this;

        // gives back the target temperature of thermostat
        // crashes the plugin IF there is no value defined (like
        // with DOMESTIC_HOT_WATER) so we need to chek if it
        // is defined first
        if (this.model = "HeatingZone"){
            var targetTemperature = this.thermostat.setpointStatus.targetHeatTemperature;
            that.log("Target temperature for", this.name, "is", targetTemperature + "°");
        } else {
            var targetTemperature = 0;
            that.log("Will set target temperature for", this.name, "to " + targetTemperature + "°");
        }
        callback(null, Number(targetTemperature));

    },

    getTemperatureDisplayUnits: function(callback) {
        var that = this;
        var temperatureUnits = 0;

        switch(this.temperatureUnit) {
            case "Fahrenheit":
                temperatureUnits = 1;
                break;
            case "Celsius":
                temperatureUnits = 0;
                break;
            default:
                temperatureUnits = 0;
        }

        callback(null, Number(temperatureUnits));
    },

    setTemperatureDisplayUnits: function(value, callback) {
        var that = this;

        that.log("set temperature units to", value);
        callback();
    },

    getValvePosition: function(callback) {
        // not implemented
        callback(null, 50);
    },

    setProgramCommand: function(value, callback) {
        // not implemented
        callback();
    },

    getProgramData: function(callback) {
        // not implemented
        var data  = "12f1130014c717040af6010700fc140c170c11fa24366684ffffffff24366684ffffffff24366684ffffffff24366684ffffffff24366684ffffffff24366684ffffffff24366684fffffffff42422222af3381900001a24366684ffffffff";
        var buffer = new Buffer(('' + data).replace(/[^0-9A-F]/ig, ''), 'hex').toString('base64');
        callback(null, buffer);
    },

    getServices: function() {
        var that = this;

        // Information Service
        var informationService = new Service.AccessoryInformation();

        //var serial = 123456 + this.deviceId;
        var strSerial = this.serial.toString();

        informationService
        .setCharacteristic(Characteristic.Identify, this.name)
        .setCharacteristic(Characteristic.Manufacturer, "Honeywell")
        .setCharacteristic(Characteristic.Model, this.model)
        .setCharacteristic(Characteristic.Name, this.name)
        .setCharacteristic(Characteristic.SerialNumber, strSerial); // need to stringify the this.serial

        // Thermostat Service
        //this.thermostatService = new Service.Thermostat("Honeywell Thermostat");
        // Remove the old way above because it creates all devices as "Honeywell Thermostat" so I have no idea which thermostat it is.
        // This new way creates each thermostat as its own room name, as pulled from Evohome
        this.thermostatService = new Service.Thermostat(this.name);

        // Required Characteristics /////////////////////////////////////////////////////////////
        // this.addCharacteristic(Characteristic.CurrentHeatingCoolingState); READ
        this.thermostatService
        .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
        .on('get', this.getCurrentHeatingCoolingState.bind(this));

        // this.addCharacteristic(Characteristic.TargetHeatingCoolingState); READ WRITE
        this.thermostatService
        .getCharacteristic(Characteristic.TargetHeatingCoolingState)
        .on('get', this.getTargetHeatingCooling.bind(this))
        .on('set', this.setTargetHeatingCooling.bind(this));

        // this.addCharacteristic(Characteristic.CurrentTemperature); READ
        this.thermostatService
        .getCharacteristic(Characteristic.CurrentTemperature)
        .on('get', this.getCurrentTemperature.bind(this))
        .setProps({
                    minValue: 1,
                    maxValue: 50,
                    minStep: this.device.valueResolution
                  });

        // this.addCharacteristic(Characteristic.TargetTemperature); READ WRITE
        this.thermostatService
        .getCharacteristic(Characteristic.TargetTemperature)
        .on('get', this.getTargetTemperature.bind(this))
        .on('set', this.setTargetTemperature.bind(this))
        .setProps({
                    minValue: this.device.minHeatSetpoint,
                    maxValue: this.device.maxHeatSetpoint,
                    minStep: this.device.valueResolution
                  });

        // this.addCharacteristic(Characteristic.TemperatureDisplayUnits); READ WRITE
        this.thermostatService
        .getCharacteristic(Characteristic.TemperatureDisplayUnits)
        .on('get', this.getTemperatureDisplayUnits.bind(this));

        // Optional Characteristics /////////////////////////////////////////////////////////////
        // this.addOptionalCharacteristic(Characteristic.CurrentRelativeHumidity);
        // this.addOptionalCharacteristic(Characteristic.TargetRelativeHumidity);
        // this.addOptionalCharacteristic(Characteristic.CoolingThresholdTemperature);
        // this.addOptionalCharacteristic(Characteristic.HeatingThresholdTemperature);
        // this.addOptionalCharacteristic(Characteristic.Name);

        this.thermostatService.addCharacteristic(CustomCharacteristic.ValvePosition);
        this.thermostatService.addCharacteristic(CustomCharacteristic.ProgramCommand);
        this.thermostatService.addCharacteristic(CustomCharacteristic.ProgramData);

        this.thermostatService
        .getCharacteristic(CustomCharacteristic.ValvePosition)
        .on('get', this.getValvePosition.bind(this));

        this.thermostatService
        .getCharacteristic(CustomCharacteristic.ProgramCommand)
        .on('set', this.setProgramCommand.bind(this));

        this.thermostatService
        .getCharacteristic(CustomCharacteristic.ProgramData)
        .on('get', this.getProgramData.bind(this));

        return [informationService, this.thermostatService, this.loggingService];

    }
}

function EvohomeSwitchAccessory(platform, log, name, systemId, systemMode, active, username, password) {
    this.uuid_base = systemId + ":" + systemMode;
    this.name = name;
    this.systemId = systemId;
    this.systemMode = systemMode;
    this.active = active;
    this.platform = platform;
    this.username = username;
    this.password = password;
    this.log = log;
}

EvohomeSwitchAccessory.prototype = {
    getActive: function(callback) {
        var that = this;
        that.log("System mode " + that.systemMode + " is " + that.active);
        callback(null, that.active);
    },

    setActive: function(value, callback) {
        var that = this;
        var session = that.platform.sessionObject;
        var systemMode;

        if(value) {
            systemMode = that.systemMode;
        } else {
            systemMode = "Auto";
        }

        session.setSystemMode(that.systemId, systemMode).then(function (taskId) {
            if(taskId.id != null) {
                that.log("System mode is set to: " + systemMode);
                that.log(taskId);

                // force update to get newest values from Honeywell with delay of 3 seconds (else it's too fast)
                setTimeout(function() {
                    that.platform.periodicUpdate();
                }, 3 * 1000);

                that.active = value;
                callback(null, Number(1));
            } else {
                throw taskId;
            }
        }).fail(function(err) {
            that.log('Evohome failed:', err);
            callback(err);
        });
    },

    getServices: function() {
        var that = this;

        // Information Service
        var informationService = new Service.AccessoryInformation();

        informationService
        .setCharacteristic(Characteristic.Identify, this.name)
        .setCharacteristic(Characteristic.Manufacturer, "Honeywell")
        .setCharacteristic(Characteristic.Model, this.model)
        .setCharacteristic(Characteristic.Name, this.name)
        .setCharacteristic(Characteristic.SerialNumber, this.systemMode);

        // Switch service
        this.switchService = new Service.Switch;

        // Required Characteristics /////////////////////////////////////////////////////////////
        // this.addCharacteristic(Characteristic.On); READ WRITE
        this.switchService
        .getCharacteristic(Characteristic.On)
        .on('get', this.getActive.bind(this))
        .on('set', this.setActive.bind(this));

        return [informationService, this.switchService];

    }
}
