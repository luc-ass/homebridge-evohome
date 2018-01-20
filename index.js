// This platform integrates Honeywell Evohome into homebridge
// As I only own a few thermostats and no window sensors I have not yet integrated them.
//
// The configuration is stored inside the ../config.json
// {
//     "platform": "Evohome",
//     "name" : "Evohome",
//     "username" : "username/email",
//     "password" : "password",
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

    this.username = config['username'];
    this.password = config['password'];
    this.temperatureUnit = config['temperatureUnit'];
    
    this.cache_timeout = 300; // seconds
    this.interval_setTemperature = 5; // seconds

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

            session.getLocations().then(function(locations){
                this.log('You have', locations.length, 'location(s). Only the first one will be used!');
                this.log('You have', locations[0].devices.length, 'device(s).')
                
                session.getThermostats(locations[0].locationID).then(function(thermostats){

                // iterate through the devices
                for (var deviceId in locations[0].devices) {
                    for(var thermoId in thermostats) {
                        if(locations[0].devices[deviceId].zoneID == thermostats[thermoId].zoneId) {
                            // print name of the device
                            this.log(deviceId + ": " + locations[0].devices[deviceId].name + " (" + thermostats[thermoId].temperatureStatus.temperature + "°)");

                            if(locations[0].devices[deviceId].name  == "") {
                                // Device name is empty
                                // Probably Hot Water
                                // Do not store
                                this.log("Found blank device name, probably stored hot water. Ignoring device for now.");
                            }
                            else {
                                // store device in var
                                var device = locations[0].devices[deviceId];
                                // store thermostat in var
                                var thermostat = thermostats[thermoId];
                                // store name of device
                                var name = locations[0].devices[deviceId].name + " Thermostat";
                                // timezone offset in minutes
                                var offsetMinutes = locations[0].timeZone.offsetMinutes;
                                // create accessory (only if it is "HeatingZone")
                                if (device.modelType = "HeatingZone") {
                                    var accessory = new EvohomeThermostatAccessory(that.log, name, device, deviceId, thermostat, this.temperatureUnit, this.username, this.password, this.interval_setTemperature, offsetMinutes);
                                    // store accessory in myAccessories
                                    this.myAccessories.push(accessory);
                                }
                            }
                        }
                    }
                }
                
                callback(this.myAccessories);
                                        
                setInterval(that.periodicUpdate.bind(this), this.cache_timeout * 1000);
                
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

EvohomePlatform.prototype.periodicUpdate = function(session,myAccessories) {
    
    if(!this.updating && this.myAccessories){
        this.updating = true;
        
        evohome.login(this.username, this.password).then(function(session) {
                                                         
            session.getLocations().then(function(locations){
                                                                                     
                session.getThermostats(locations[0].locationID).then(function(thermostats){
                                
                    for (var deviceId in locations[0].devices) {
                        for(var thermoId in thermostats) {
                            if(locations[0].devices[deviceId].zoneID == thermostats[thermoId].zoneId) {
                                for(var i=0; i<this.myAccessories.length; ++i) {
                                    if(this.myAccessories[i].device.zoneID == locations[0].devices[deviceId].zoneID) {

                                        var device = locations[0].devices[deviceId];
                                        var thermostat = thermostats[thermoId];

                                        if(device) {
                                            // Check if temp has changed
                                            var oldCurrentTemp = this.myAccessories[i].thermostat.temperatureStatus.temperature;
                                            var newCurrentTemp = thermostat.temperatureStatus.temperature;

                                            var service = this.myAccessories[i].thermostatService;

                                            if(oldCurrentTemp!=newCurrentTemp && service) {
                                                this.log("Updating: " + device.name + " currentTempChange from: " + oldCurrentTemp + " to: " + newCurrentTemp);
                                            }

                                            var oldTargetTemp = this.myAccessories[i].thermostat.setpointStatus.targetHeatTemperature;
                                            var newTargetTemp = thermostat.setpointStatus.targetHeatTemperature;

                                            if(oldTargetTemp!=newTargetTemp && service) {
                                                this.log("Updating: " + device.name + " targetTempChange from: " + oldTargetTemp + " to: " + newTargetTemp);
                                            }

                                            this.myAccessories[i].device = device;
                                            this.myAccessories[i].thermostat = thermostat;

                                            var loggingService = this.myAccessories[i].loggingService;

                                            //this.log("populating loggingService: " + loggingService);
                                            //this.log(moment().unix() + " " + newCurrentTemp + " " + newTargetTemp);
                                            loggingService.addEntry({time:moment().unix(), currentTemp:newCurrentTemp, setTemp:newTargetTemp, valvePosition:50}); // valve pos 50%???

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
function EvohomeThermostatAccessory(log, name, device, deviceId, thermostat, temperatureUnit, username, password, interval_setTemperature, offsetMinutes) {
    this.name = name;

    this.displayName = name; // fakegato
    this.device = device;
    this.model = device.modelType;
    this.serial = deviceId;

    this.deviceId = deviceId;
    
    this.thermostat = thermostat;
    this.temperatureUnit = temperatureUnit;
    
    this.username = username;
    this.password = password;

    this.log = log;
    
    this.loggingService = new FakeGatoHistoryService("thermo", this);

    this.targetTemperateToSet = -1;

    this.offsetMinutes = offsetMinutes;

    setInterval(this.periodicCheckSetTemperature.bind(this), interval_setTemperature * 1000);
}

EvohomeThermostatAccessory.prototype = {

    periodicCheckSetTemperature: function() {
        var that = this;
        var value = that.targetTemperateToSet;

        if(value != -1) {
            evohome.login(that.username, that.password).then(function (session) {
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
                    
                    var currenttime = correctDate.toLocaleTimeString();
                    var proceed = true;
                    var nextScheduleTime = "";
                    
                    for(var scheduleId in schedule) {
                        if(schedule[scheduleId].dayOfWeek == weekday[weekdayNumber]) {
                            var switchpoints = schedule[scheduleId].switchpoints;
                            for(var switchpointId in switchpoints) {
                                if(proceed == true) {
                                    if(currenttime >= switchpoints[switchpointId].timeOfDay) {
                                        proceed = true;
                                    } else if (currenttime < switchpoints[switchpointId].timeOfDay) {
                                        proceed = false;
                                        nextScheduleTime = switchpoints[switchpointId].timeOfDay;
                                    }
                                }
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
                        that.thermostat.setpointStatus.targetHeatTemperature = value;
                        // set target temperature here also to prevent from setting temperature two times
                        // nothing else here...
                        //callback(null, Number(1));
                    });
                }).fail(function(err) {
                    that.log('Evohome failed:', err);
                    //callback(null, Number(0));
                });
            }).fail(function (err) {
                that.log('Evohome Failed:', err);
                //callback(null, Number(0));
            });

            that.targetTemperateToSet = -1;
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

        that.log("getCurrentHeatingCooling");

        // TODO:
        // fixed until it can be requested from Evohome...
        // OFF  = 0
        // HEAT = 1
        // COOL = 2
        // AUTO = 3
        callback(null, Number(1));

    },

    getName: function(callback) {

        var that = this;

        that.log("requesting name of", this.name);

        callback(this.name);

    },

    setTargetHeatingCooling: function(value, callback) {
        var that = this;

        // not implemented 

        that.log("attempted to change targetHeatingCooling: " + value +" - not yet implemented");
        callback();

    },

    getTargetHeatingCooling: function(callback) {
        var that = this;

        // TODO:
        // fixed until it can be requested from Evohome...
        // OFF  = 0
        // HEAT = 1
        // COOL = 2
        // AUTO = 3
        callback(null, Number(1));

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
            that.log("Device type is: " + this.model + ". Target temperature should be there.");
            that.log("Target temperature for", this.name, "is", targetTemperature + "°");
        } else {
            var targetTemperature = 0;
            that.log("Device type is: " + this.model + ". Target temperature is probably NOT there (this is normal).");
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
                  minValue: 5,
                  maxValue: 35,
                  minStep: 0.5
                  });

        // this.addCharacteristic(Characteristic.TargetTemperature); READ WRITE
        this.thermostatService
        .getCharacteristic(Characteristic.TargetTemperature)
        .on('get', this.getTargetTemperature.bind(this))
        .on('set', this.setTargetTemperature.bind(this))
        .setProps({
                  minValue: 5,
                  maxValue: 35,
                  minStep: 0.5
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
