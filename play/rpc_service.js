/*jslint node: true */

/*
	Accept commands via JSON-RPC API.
	The daemon listens on port 6332 by default.
	See https://github.com/byteball/headless-byteball/wiki/Running-RPC-service for detailed description of the API
*/

"use strict";
var headlessWallet = require('../start.js');
var split = require('./split.js');
var conf = require('bng-core/conf.js');
var eventBus = require('bng-core/event_bus.js');
var db = require('bng-core/db.js');
var mutex = require('bng-core/mutex.js');
var storage = require('bng-core/storage.js');
var constants = require('bng-core/constants.js');
var validationUtils = require("bng-core/validation_utils.js");
var wallet_id;
var http = require('http');
var querystring = require('querystring');
if (conf.bSingleAddress)
    throw Error('can`t run in single address mode');

function initRPC() {
    var composer = require('bng-core/composer.js');
    var network = require('bng-core/network.js');

    var rpc = require('json-rpc2');
    var walletDefinedByKeys = require('bng-core/wallet_defined_by_keys.js');
    var Wallet = require('bng-core/wallet.js');
    var balances = require('bng-core/balances.js');

    var server = rpc.Server.$create({
        'websocket': true, // is true by default
        'headers': { // allow custom headers is empty by default
            'Access-Control-Allow-Origin': '*'
        }
    });

    /**
     * Returns information about the current state.
     * @return { last_mci: {Integer}, last_stable_mci: {Integer}, count_unhandled: {Integer} }
     */
    server.expose('getinfo', function (args, opt, cb) {
        console.log("==============================", JSON.stringify(args));
        var response = {};
        storage.readLastMainChainIndex(function (last_mci) {
            response.last_mci = last_mci;
            storage.readLastStableMcIndex(db, function (last_stable_mci) {
                response.last_stable_mci = last_stable_mci;
                db.query("SELECT COUNT(*) AS count_unhandled FROM unhandled_joints", function (rows) {
                    response.count_unhandled = rows[0].count_unhandled;
                    db.query("SELECT address FROM unit_witnesses", function (rows) {
                        response.witnesses = rows;
                        cb(null, response);
                    });
                });
            });
        });
    });

    /**
     * Validates address.
     * @return {boolean} is_valid
     */
    server.expose('validateaddress', function (args, opt, cb) {
        var address = args[0];
        cb(null, validationUtils.isValidAddress(address));
    });

    // alias for validateaddress
    server.expose('verifyaddress', function (args, opt, cb) {
        var address = args[0];
        cb(null, validationUtils.isValidAddress(address));
    });
    server.expose('getfirstaddress', function (args, opt, cb) {
        getdefaultaddress(function (add) {
            cb(null, add);
        });
    });

    /**
     * Creates and returns new wallet address.
     * @return {String} address
     */
    server.expose('getnewaddress', function (args, opt, cb) {
        mutex.lock(['rpc_getnewaddress'], function (unlock) {
            walletDefinedByKeys.issueNextAddress(wallet_id, 0, function (addressInfo) {
                unlock();
                cb(null, addressInfo.address);
            });
        });
    });

    /**
     * Returns address balance(stable and pending).
     * If address is invalid, then returns "invalid address".
     * If your wallet doesn`t own the address, then returns "address not found".
     * @param {String} address
     * @return {"base":{"stable":{Integer},"pending":{Integer}}} balance
     *
     * If no address supplied, returns wallet balance(stable and pending).
     * @return {"base":{"stable":{Integer},"pending":{Integer}}} balance
     */
    server.expose('getbalance', function (args, opt, cb) {
        let start_time = Date.now();
        var address = args[0];
        var asset = args[1];
        if (address) {
            if (validationUtils.isValidAddress(address))
                db.query("SELECT COUNT(*) AS count FROM my_addresses WHERE address = ?", [address], function (rows) {
                    if (rows[0].count)
                        db.query(
                            "SELECT asset, is_stable, SUM(amount) AS balance \n\
                            FROM outputs JOIN units USING(unit) \n\
                            WHERE is_spent=0 AND address=? AND sequence='good' AND asset " + (asset ? "=" + db.escape(asset) : "IS NULL") + " \n\
							GROUP BY is_stable", [address],
                            function (rows) {
                                var balance = {};
                                balance[asset || 'base'] = {
                                    stable: 0,
                                    pending: 0
                                };
                                for (var i = 0; i < rows.length; i++) {
                                    var row = rows[i];
                                    balance[asset || 'base'][row.is_stable ? 'stable' : 'pending'] = row.balance;
                                }
                                cb(null, balance);
                            }
                        );
                    else
                        cb("address not found");
                });
            else
                cb("invalid address");
        }
        else
            Wallet.readBalance(wallet_id, function (balances) {
                console.log('getbalance took ' + (Date.now() - start_time) + 'ms');
                cb(null, balances);
            });
    });

    /**
     * Returns wallet balance(stable and pending) without commissions earned from headers and witnessing.
     *
     * @return {"base":{"stable":{Integer},"pending":{Integer}}} balance
     */
    server.expose('getmainbalance', function (args, opt, cb) {
        let start_time = Date.now();
        balances.readOutputsBalance(wallet_id, function (balances) {
            console.log('getmainbalance took ' + (Date.now() - start_time) + 'ms');
            cb(null, balances);
        });
    });

    /**
     * Returns transaction list.
     * If address is invalid, then returns "invalid address".
     * @param {String} address or {since_mci: {Integer}, unit: {String}}
     * @return [{"action":{'invalid','received','sent','moved'},"amount":{Integer},"my_address":{String},"arrPayerAddresses":[{String}],"confirmations":{0,1},"unit":{String},"fee":{Integer},"time":{String},"level":{Integer},"asset":{String}}] transactions
     *
     * If no address supplied, returns wallet transaction list.
     * @return [{"action":{'invalid','received','sent','moved'},"amount":{Integer},"my_address":{String},"arrPayerAddresses":[{String}],"confirmations":{0,1},"unit":{String},"fee":{Integer},"time":{String},"level":{Integer},"asset":{String}}] transactions
     */
    server.expose('listtransactions', function (args, opt, cb) {
        let start_time = Date.now();
        if (Array.isArray(args) && typeof args[0] === 'string') {
            var address = args[0];
            if (validationUtils.isValidAddress(address))
                Wallet.readTransactionHistory({address: address}, function (result) {
                    cb(null, result);
                });
            else
                cb("invalid address");
        }
        else {
            // var opts = {wallet: wallet_id};
            var opts = {address: args.address};
            if (args.unit && validationUtils.isValidBase64(args.unit, constants.HASH_LENGTH))
                opts.unit = args.unit;
            if (args.since_mci && validationUtils.isNonnegativeInteger(args.since_mci))
                opts.since_mci = args.since_mci;
            else
                opts.limit = 200;
            opts.asset = conf.ynasset;
            Wallet.readTransactionHistory(opts, function (result) {
                console.log('listtransactions ' + JSON.stringify(args) + ' took ' + (Date.now() - start_time) + 'ms');
                cb(null, result);
            });
        }

    });

    /**
     * Send funds to address.
     * If address is invalid, then returns "invalid address".
     * @param {String} address
     * @param {Integer} amount
     * @return {String} status
     */
    server.expose('sendtoaddress', function (args, opt, cb) {
        console.log('sendtoaddress ' + JSON.stringify(args));
        let start_time = Date.now();
        var amount = args[1];
        var toAddress = args[0];
        var asset = args[2];
        if (asset && !validationUtils.isValidBase64(asset, constants.HASH_LENGTH))
            return cb("bad asset: " + asset);
        if (amount && toAddress) {
            if (validationUtils.isValidAddress(toAddress))
                headlessWallet.issueChangeAddressAndSendPayment(asset, amount, toAddress, null, function (err, unit) {
                    console.log('sendtoaddress ' + JSON.stringify(args) + ' took ' + (Date.now() - start_time) + 'ms, unit=' + unit + ', err=' + err);
                    cb(err, err ? undefined : unit);
                });
            else
                cb("invalid address");
        }
        else
            cb("wrong parameters");
    });

    /**
     * 批量转账
     * [["N4PCD3NG6JUT5B2YBBGJ6HJCO4JS37XH","VLM4KA5FDBQ73NXQGMUDC7C47CTEOLDZ"],123]
     */
    server.expose('sendtoMultiaddress', function (args, opt, cb) {
        var composer = require('bng-core/composer.js');
        var network = require('bng-core/network.js');
        var callbacks = composer.getSavingCallbacks({
            ifNotEnoughFunds: function (err) {
                cb(err);
            },
            ifError: function (err) {
                cb(err);
            },
            ifOk: function (objJoint) {
                network.broadcastJoint(objJoint);
                cb(null, objJoint)
            }
        });
        getdefaultaddress(function (add) {
            var from_address = add;
            var payee_address = args[0];
            var arrOutputs = [
                {address: from_address, amount: 0},      // the change
            ];
            for (var i = 0; i < payee_address.length; i++) {
                var obj = {
                    address: payee_address[i],
                    amount: args[1]
                };
                arrOutputs.push(obj);
            }
            composer.composePaymentJoint([from_address], arrOutputs, headlessWallet.signer, callbacks);
        });
    });

    server.expose('createPayment', function (args, opt, cb) {
        var composer = require('bng-core/composer.js');
        var network = require('bng-core/network.js');
        var callbacks = composer.getSavingCallbacks({
            ifNotEnoughFunds: function (err) {
                cb(err);
            },
            ifError: function (err) {
                cb(err);
            },
            ifOk: function (objJoint) {
                network.broadcastJoint(objJoint);
                cb(null, objJoint)
            }
        });

        var from_address = args[0];
        var payee_address = args[1];
        var arrOutputs = [
            {address: from_address, amount: 0},      // the change
            {address: payee_address, amount: args[2]}  // the receiver
        ];
        composer.composePaymentJoint([from_address], arrOutputs, headlessWallet.signer, callbacks);
    });
    /**
     *  Returns all the address of headless
     *  @return [{"address": ""}]
     */
    server.expose('getaddresses', function (args, opt, cb) {
        console.log('getaddresses ' + JSON.stringify(args));
        var adds = [];
        db.query("SELECT address FROM my_addresses", function (rows) {
            if (rows.length === 0)
                throw Error("no wallets");
            for (var i in rows) {
                var property = rows[i];
                adds.push(property);
                console.log("Witness SingleAddress --------------> " + JSON.stringify(property) + "\n");
            }
            cb(null, adds);
        });
    });

    server.expose('createdata', function (args, opt, cb) {
        var composer = require('bng-core/composer.js');
        var network = require('bng-core/network.js');
        var callbacks = composer.getSavingCallbacks({
            ifNotEnoughFunds: function (err) {
                cb(err);
            },
            ifError: function (err) {
                cb(err);
            },
            ifOk: function (objJoint) {
                network.broadcastJoint(objJoint);

                cb(null, objJoint);
            }
        });

        composer.composeDataJoint(args[1], args[0], headlessWallet.signer, callbacks);
    });

    /**
     * 获取付款字符串，前端qrcode生成二维码
     */
    server.expose('getpaycode', function (args, opt, cb) {
        var code = "byteball:" + args[0] + "?" + "amount=" + args[1] + "&asset=" + encodeURIComponent(conf.ynasset);
        cb(null, code);
    });

    /**
     * 前端调用，等待unit稳定后通知前端
     */
    server.expose('waitstable', function (args, opt, cb) {
        eventBus.once('new_unit' + args[0], function (objJoint) {
            if (objJoint === args[1]) {
                notifyserver(args[0]);
            }
        });
        cb(null, true);
    });
    server.expose('waitunitstable', function (args, opt, cb) {
        eventBus.once('my_stable-' + args[0], function () {
            console.log(args[0] + "became stable");
            notifyserver(args[0]);
        });
        cb(null, true);
    });

    server.expose('createdatafeed', function (args, opt, cb) {
        var composer = require('bng-core/composer.js');
        var network = require('bng-core/network.js');
        var callbacks = composer.getSavingCallbacks({
            ifNotEnoughFunds: function (err) {
                cb(err);
            },
            ifError: function (err) {
                cb(err);
            },
            ifOk: function (objJoint) {
                network.broadcastJoint(objJoint);
                cb(null, objJoint);
            }
        });
        composer.composeDataFeedJoint(args[1], args[0], headlessWallet.signer, callbacks);
    });

    headlessWallet.readSingleWallet(function (_wallet_id) {
        wallet_id = _wallet_id;
        // listen creates an HTTP server on localhost only
        var httpServer = server.listen(conf.rpcPort, conf.rpcInterface);
        httpServer.timeout = 900 * 1000;
    });
    getdefaultaddress(function (address) {
        split.startCheckingAndSplittingLargestOutput(address, 0);
    });
}

function getdefaultaddress(callback) {
    db.query("SELECT address FROM my_addresses ORDER BY creation_date ASC", function (rows) {
        if (rows.length === 0)
            throw Error("no wallets");
        var address = rows[0].address;
        console.log("Witness SingleAddress --------------> " + JSON.stringify(address) + "\n");
        callback(address);
    });
}

eventBus.on('headless_wallet_ready', initRPC);

function notifyserver(unit, data) {
    var postData = {
        unit: unit,
        data: data
    };
    var content = querystring.stringify(postData);

    var options = {
        host: '127.0.0.1',
        path: '/api/assets/notify',
        method: 'POST',
        port: 8080,
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': content.length
        }
    };

    var req = http.request(options, function (res) {
        res.setEncoding('utf8');
        var body = '';
        res.on('data', function (chunk) {
            body += chunk;
        });
        res.on('end', function () {
            console.log(res.headers);
            console.log(body);
        });
    });

    req.write(content);
    req.end();
};