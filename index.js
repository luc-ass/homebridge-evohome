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

var evohome = require('evohome');
var Service, Characteristic;

module.exports = function(homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  
  homebridge.registerPlatform("homebridge-evohome", "Evohome", EvohomePlatform);
}

function EvohomePlatform(log, config){

	this.username = config['username'];
	this.password = config['password'];
	this.appId = config['appId'];
    
    this.cache_timeout = 45; // seconds

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
					
					// store device in var
					var device = locations[0].devices[deviceId];
					// store name of device
					var name = locations[0].devices[deviceId].name + " Thermostat";
					// create accessory
					var accessory = new EvohomeThermostatAccessory(that.log, name, device, deviceId);
					// store accessory in myAccessories
					this.myAccessories.push(accessory);
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
                                        
                    // Check if temp has changed
                    var oldCurrentTemperature = this.myAccessories[i].device.thermostat.indoorTemperature;
                    var newCurrentTemperature = device.thermostat.indoorTemperature;
                                    
                    var currentTempChange = oldCurrentTemperature-newCurrentTemperature;
                                        
                    if(currentTempChange && this.thermostatService) {
                        var charCT = getCharacteristic(Characteristic.CurrentTemperature);
                        if(charCT) charCT.setValue(newCurrentTemperature);
                    }
                                        
                    this.log.debug("Updating: " + device.name + " old-new = " + currentTempChange);
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
function EvohomeThermostatAccessory(log, name, device, deviceId) {
	this.name = name;
	this.device = device;
	this.model = device.thermostatModelType;
	this.serial = device.deviceID;
	this.deviceId = deviceId;

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

		that.log("Setting target temperature for", this.name, "to", value + "°");
		callback(null, Number(0));

	},

	getTargetTemperature: function(callback) {
		var that = this;

		// just trying this out... shoud give back 128
		var targetTemperature = this.device.thermostat.changeableValues.heatSetpoint['value'];
		that.log("Target temperature for", this.name, "is", targetTemperature + "°");
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
        this.thermostatService = new Service.Thermostat("Honeywell Thermostat");

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

  		// this.addCharacteristic(Characteristic.TargetTemperature); READ WRITE
  		this.thermostatService
  			.getCharacteristic(Characteristic.TargetTemperature)
  			.on('get', this.getTargetTemperature.bind(this))
  			.on('set', this.setTargetTemperature.bind(this));

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