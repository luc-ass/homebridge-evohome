// This platform integrates Honeywell Evohome into homebridge
// As I only own a few thermostats and no window sensors I have not yet integrated them.
//
// The configuration is stored inside the ../config.json
// {
//     "platform": "Evohome",
//     "name" : "Evohome",
//     "username" : "username/email",
//     "password" : "password",
//     "appId" : "91db1612-73fd-4500-91b2-e63b069b185c"
// }
//
// not yet sure wether application-id-hex (appID) is really changing so I put it here as default.

'use strict';

var evohome = require('./lib/evohome.js');
var Service, Characteristic;
var config;

module.exports = function(homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  
  homebridge.registerPlatform("homebridge-evohome", "Evohome", EvohomePlatform);
}

function EvohomePlatform(log, config){

	this.username = config['username'];
	this.password = config['password'];
	this.appId = config['appId'] || "91db1612-73fd-4500-91b2-e63b069b185c";
    
    this.minTemp = config['minTemp'] || 15.0;
    this.maxTemp = config['maxTemp'] || 25.0;
    
    this.cache_timeout = 10;//890; // seconds

	this.log = log;
    
  this.updating = false;
}

EvohomePlatform.prototype = {
	accessories: function(callback) {
		this.log("Logging into Evohome...");

		var that = this;
		// create the myAccessories array
		this.myAccessories = [];

		evohome.login(that.username, that.password, that.appId).then(function(session) {
			this.log("Logged into Evohome!");

			session.getLocations().then(function(locations){
				this.log('You have', locations.length, 'location(s). Only the first one will be used!');
				this.log('You have', locations[0].devices.length, 'device(s).')

				// iterate through the devices
				for (var deviceId in locations[0].devices) {
					// print name of the device
					this.log(deviceId + ": " + locations[0].devices[deviceId].name + " (" + locations[0].devices[deviceId].thermostat.indoorTemperature + "°)");

                                        if(locations[0].devices[deviceId].name  == "") {
                                                // Device name is empty
                                                // Probably Hot Water
                                                // Do not store
                                               	this.log("Found blank device name, probably stored hot water. Ignoring device for now.");
                                        }
                                        else {
						// store device in var
						var device = locations[0].devices[deviceId];
						// store name of device
						var name = locations[0].devices[deviceId].name + " Thermostat";
						// create accessory (only if it is "EMEA_ZONE")
						if (device.thermostatModelType = "EMEA_ZONE") {
							var accessory = new EvohomeThermostatAccessory(that.log, name, device, deviceId, this.username, this.password, this.appId);
							// store accessory in myAccessories
							this.myAccessories.push(accessory);
						}
                                        }
				}

				callback(this.myAccessories);
                                        
                setInterval(that.periodicUpdate.bind(this), this.cache_timeout * 1000);

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
        
        evohome.login(this.username, this.password, this.appId).then(function(session) {
        
            session.getLocations().then(function(locations){
                                    
                for(var i=0; i<this.myAccessories.length; ++i) {
                    var device = locations[0].devices[this.myAccessories[i].deviceId];

                    if(device) {
                        // Check if temp has changed
                        var oldCurrentTemp = this.myAccessories[i].device.thermostat.indoorTemperature;
                        var newCurrentTemp = device.thermostat.indoorTemperature;
                                        
                        var service = this.myAccessories[i].thermostatService;
                                        
                        if(oldCurrentTemp!=newCurrentTemp && service) {
                            this.log("Updating: " + device.name + " currentTempChange from: " + oldCurrentTemp + " to: " + newCurrentTemp);
                            var charCT = service.getCharacteristic(Characteristic.CurrentTemperature);
                            if(charCT) charCT.setValue(newCurrentTemp);
                            else this.log("No Characteristic.CurrentTemperature found " + service);
                        }
                                        
                        var oldMode = this.myAccessories[i].device.thermostat.changeableValues.mode;
                        var newMode = device.thermostat.changeableValues.mode;
                                        
                        if(oldMode!=newMode && service) {
                            this.log("Updating: " + device.name + " modeChange from: " + oldMode + " to: " + newMode);
                            var charMode = service.getCharacteristic(Characteristic.TargetHeatingCoolingState);
                            if(charMode) charMode.setValue(newMode == "Off" ? 0 : 1); // No cooling/auto state
                            else this.log("No Characteristic.TargetHeatingCoolingState found " + service);
                        }
                                        
                        var oldTargetTemp = this.myAccessories[i].device.thermostat.changeableValues.heatSetpoint['value'];
                        var newTargetTemp = device.thermostat.changeableValues.heatSetpoint['value'];
                                        
                        if(oldTargetTemp!=newTargetTemp && service) {
                            this.log("Updating: " + device.name + " targetTempChange from: " + oldTargetTemp + " to: " + newTargetTemp);
                            var charTT = service.getCharacteristic(Characteristic.TargetTemperature);
                            if(charTT) charCT.setValue(newTargetTemp);
                            else this.log("No Characteristic.TargetTemperature found " + service);
                        }
                        this.myAccessories[i].device = device;
                    }
                }
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
function EvohomeThermostatAccessory(log, name, device, deviceId, username, password, appId) {
	this.name = name;
	this.device = device;
	this.model = device.thermostatModelType;
	this.serial = device.deviceID;
	this.deviceId = deviceId;
	
	this.username = username;
	this.password = password;
	this.appId = appId;

	this.log = log;
}

EvohomeThermostatAccessory.prototype = {
	
	getCurrentTemperature: function(callback) {
		var that = this;

		// need to refresh data if outdated!!
		var currentTemperature = this.device.thermostat.indoorTemperature;
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
        
        var mode = this.device.thermostat.changeableValues.mode == "Off" ? 0 : 1;
        
        that.log("currentHeatingCooling = " + mode);
        
		callback(null, Number(mode));

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
        
        that.log("getTargetHeatingCooling");

		// TODO:
		// fixed until it can be requested from Evohome...
		// OFF  = 0
		// HEAT = 1
		// COOL = 2
		// AUTO = 3
        
        var mode = this.device.thermostat.changeableValues.mode == "Off" ? 0 : 1;
        
        that.log("currentTargetHeatingCooling = " + mode);
        
		callback(null, Number(mode));

	},

   setTargetTemperature: function(value, callback) {
	  var that = this;
	            
    that.log("Setting target temperature for", this.name, "to", value + "°");
    var minutes = 10; // The number of minutes the new target temperature will be effective
        // TODO:
        // verify that the task did succeed
		
    evohome.login(this.username, this.password, this.appId).then(function (session) {
      session.setHeatSetpoint(that.serial, value, minutes).then(function (taskId) {
        that.log("Successfully changed temperature!");
        that.log(taskId);
        // returns taskId if successful
        // nothing else here...
        callback(null, Number(1));
      });
    }).fail(function (err) {
      that.log('Evohome Failed:', err);
      callback(null, Number(0));
    });
    callback(null, Number(0));
  },

	getTargetTemperature: function(callback) {
		var that = this;
        
        var targetTemperature = 0;

		// gives back the target temperature of thermostat
		// crashes the plugin IF there is no value defined (like 
		// with DOMESTIC_HOT_WATER) so we need to chek if it
		// is defined first
		if (this.model = "EMEA_ZONE"){
            targetTemperature = this.device.thermostat.changeableValues.heatSetpoint['value'];
			that.log("Device type is: " + this.model + ". Target temperature should be there.");
			that.log("Target temperature for", this.name, "is", targetTemperature + "°");
		} else {
			targetTemperature = 0;
			that.log("Device type is: " + this.model + ". Target temperature is probably NOT there (this is normal).");
			that.log("Will set target temperature for", this.name, "to " + targetTemperature + "°");
		}
		callback(null, Number(targetTemperature));

	},

	getTemperatureDisplayUnits: function(callback) {
        var that = this;
		var temperatureUnits = 0;

		switch(this.device.thermostat.units) {
			case "Fahrenheit":
				that.log("Temperature unit for", this.name, "is set to", this.device.thermostat.units);
				temperatureUnits = 1;
				break;
			case "Celsius":
				that.log("Temperature unit for", this.name, "is set to", this.device.thermostat.units);
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

    getServices: function() {
        var that = this;

        // Information Service
        var informationService = new Service.AccessoryInformation();

        informationService
        	.setCharacteristic(Characteristic.Identify, this.name)
        	.setCharacteristic(Characteristic.Manufacturer, "Honeywell")
        	.setCharacteristic(Characteristic.Model, this.model)
        	.setCharacteristic(Characteristic.Name, this.name)
        	.setCharacteristic(Characteristic.SerialNumber, "123456"); // need to stringify the this.serial

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
  			.on('get', this.getCurrentTemperature.bind(this));

        this.thermostatService.getCharacteristic(Characteristic.CurrentTemperature)
        .setProps({
                  minValue: this.minTemp,
                  maxValue: this.maxTemp,
                  minStep: 0.5
                  });

  		// this.addCharacteristic(Characteristic.TargetTemperature); READ WRITE
  		this.thermostatService
  			.getCharacteristic(Characteristic.TargetTemperature)
  			.on('get', this.getTargetTemperature.bind(this))
  			.on('set', this.setTargetTemperature.bind(this));
	    
        this.thermostatService.getCharacteristic(Characteristic.TargetTemperature)
        .setProps({
                  minValue: this.minTemp,
                  maxValue: this.maxTemp,
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

        return [informationService, this.thermostatService];

    }
}
